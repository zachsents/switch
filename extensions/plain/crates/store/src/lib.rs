//! An app's own data, kept on each device and merged between them, with no server.
//!
//! Data is entities (a kind and an id) with fields. Every edit is a [`Change`]: the fields it
//! sets on one entity, stamped by a hybrid logical clock with the device that made it. The
//! newest stamp wins each field, so changes merge the same way in any order, on every device.
//! Deleting is a field too (`deleted`), so a deletion merges like any edit.
//!
//! Each device keeps every change in SQLite. Devices share changes through a folder that a
//! file-syncing service keeps the same on all of them, iCloud Drive by default
//! ([`sync_folder`]): each device appends its own changes to files of its own there and reads
//! the others', so no two devices ever write the same file. A device that was asleep catches up
//! when it wakes. The folder is only touched off the main thread ([`export`], [`read_peers`]),
//! since iCloud may have to download a file first, which can take a minute. Each change a device
//! applies gets the next position in its local order, which is what [`Store::applied_after`]
//! reads, so apps can offer their changes as a feed with cursors that survive restarts.

mod folder;

use std::{
    collections::{BTreeMap, hash_map::RandomState},
    hash::{BuildHasher, Hasher},
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

pub use folder::{PeerRead, export, prepare, read_peers, sync_folder};

/// When a change was made and on which device: a hybrid logical clock reading. Readings order by
/// time, then by counter, then by device, so every device agrees which of two changes is newer,
/// and a device's own readings always move forward even if its clock is set back.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct Stamp {
    /// Milliseconds since the Unix epoch.
    pub millis: i64,
    pub counter: u32,
    pub device: String,
}

/// The fields one edit set on one entity.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Change {
    pub stamp: Stamp,
    pub kind: String,
    pub id: String,
    pub fields: Map<String, Value>,
}

impl Change {
    /// Identifies the change wherever it's reported.
    pub fn key(&self) -> String {
        let Stamp {
            millis,
            counter,
            device,
        } = &self.stamp;
        format!("{millis}-{counter}-{device}-{}-{}", self.kind, self.id)
    }
}

/// A change as this device applied it.
#[derive(Clone, Debug, PartialEq)]
pub struct Applied {
    /// Its position in the order this device applied changes, counting from 1.
    pub seq: u64,
    pub change: Change,
    /// The fields that took effect, being newer than what was there.
    pub took: Map<String, Value>,
}

/// An entity's current fields, each with the stamp of the change that set it.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Entity {
    fields: BTreeMap<String, (Value, Stamp)>,
}

impl Entity {
    pub fn get(&self, field: &str) -> Option<&Value> {
        self.fields.get(field).map(|(value, _)| value)
    }

    pub fn str(&self, field: &str) -> Option<&str> {
        self.get(field).and_then(Value::as_str)
    }

    pub fn bool(&self, field: &str) -> bool {
        self.get(field).and_then(Value::as_bool).unwrap_or(false)
    }

    pub fn i64(&self, field: &str) -> Option<i64> {
        self.get(field).and_then(Value::as_i64)
    }

    /// When a field was last set.
    pub fn stamp(&self, field: &str) -> Option<&Stamp> {
        self.fields.get(field).map(|(_, stamp)| stamp)
    }

    /// Whether it has been deleted.
    pub fn deleted(&self) -> bool {
        self.bool("deleted")
    }

    /// Sets each field that `stamp` is newer for, returning those.
    fn apply(&mut self, stamp: &Stamp, fields: &Map<String, Value>) -> Map<String, Value> {
        let newer: Map<String, Value> = fields
            .iter()
            .filter(|(field, _)| {
                self.fields
                    .get(*field)
                    .is_none_or(|(_, current)| stamp > current)
            })
            .map(|(field, value)| (field.clone(), value.clone()))
            .collect();
        for (field, value) in &newer {
            self.fields
                .insert(field.clone(), (value.clone(), stamp.clone()));
        }
        newer
    }
}

/// A device's copy of an app's data.
pub struct Store {
    connection: Connection,
    device: String,
    epoch: String,
    /// The newest clock reading this store has made or seen.
    clock: (i64, u32),
    entities: BTreeMap<(String, String), Entity>,
    head: u64,
}

impl Store {
    /// Opens the store at `path`, creating it if needed, for edits made on `device`.
    pub fn open(path: &Path, device: &str) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let connection = Connection::open(path).map_err(|error| error.to_string())?;
        Self::with(connection, device)
    }

    /// A store kept only in memory, for tests.
    pub fn in_memory(device: &str) -> Result<Self, String> {
        Self::with(
            Connection::open_in_memory().map_err(|error| error.to_string())?,
            device,
        )
    }

    fn with(connection: Connection, device: &str) -> Result<Self, String> {
        connection
            .execute_batch(
                "PRAGMA journal_mode = WAL;
                 CREATE TABLE IF NOT EXISTS changes (
                     seq INTEGER PRIMARY KEY AUTOINCREMENT,
                     millis INTEGER NOT NULL,
                     counter INTEGER NOT NULL,
                     device TEXT NOT NULL,
                     kind TEXT NOT NULL,
                     id TEXT NOT NULL,
                     fields TEXT NOT NULL,
                     took TEXT NOT NULL,
                     UNIQUE (millis, counter, device, kind, id)
                 );
                 CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
            )
            .map_err(|error| error.to_string())?;
        let epoch = match meta(&connection, "epoch")? {
            Some(epoch) => epoch,
            None => {
                let epoch = format!("{:x}", now_millis()) + &random_id(4);
                set_meta(&connection, "epoch", &epoch)?;
                epoch
            }
        };
        let mut store = Self {
            connection,
            device: device.to_string(),
            epoch,
            clock: (0, 0),
            entities: BTreeMap::new(),
            head: 0,
        };
        store.load()?;
        Ok(store)
    }

    /// Rebuilds the entities from every change kept.
    fn load(&mut self) -> Result<(), String> {
        self.entities.clear();
        for applied in self.read_changes(0, usize::MAX, false)? {
            let change = applied.change;
            self.observe(&change.stamp);
            self.entities
                .entry((change.kind.clone(), change.id.clone()))
                .or_default()
                .apply(&change.stamp, &change.fields);
            self.head = applied.seq;
        }
        Ok(())
    }

    pub fn device(&self) -> &str {
        &self.device
    }

    /// Identifies this copy of the data. A store made afresh has a new one, so positions from an
    /// old one aren't mistaken for its own.
    pub fn epoch(&self) -> &str {
        &self.epoch
    }

    /// The position of the newest change applied here.
    pub fn head(&self) -> u64 {
        self.head
    }

    pub fn entity(&self, kind: &str, id: &str) -> Option<&Entity> {
        self.entities.get(&(kind.to_string(), id.to_string()))
    }

    /// Every entity of a kind, deleted ones included, by id.
    pub fn entities<'a>(&'a self, kind: &'a str) -> impl Iterator<Item = (&'a str, &'a Entity)> {
        self.entities
            .iter()
            .filter(move |((entity_kind, _), _)| entity_kind == kind)
            .map(|((_, id), entity)| (id.as_str(), entity))
    }

    /// Makes an edit on this device: sets `fields` on an entity, creating it if it's new.
    pub fn write(
        &mut self,
        kind: &str,
        id: &str,
        fields: Map<String, Value>,
    ) -> Result<Applied, String> {
        let stamp = self.next_stamp();
        let change = Change {
            stamp,
            kind: kind.to_string(),
            id: id.to_string(),
            fields,
        };
        self.record(change)?
            .ok_or_else(|| "a new change was already recorded".to_string())
    }

    /// Applies changes made elsewhere, skipping any it has already. Returns those it hadn't seen.
    pub fn merge(
        &mut self,
        changes: impl IntoIterator<Item = Change>,
    ) -> Result<Vec<Applied>, String> {
        self.connection
            .execute_batch("BEGIN")
            .map_err(|error| error.to_string())?;
        let mut applied = Vec::new();
        for change in changes {
            match self.record(change) {
                Ok(Some(new)) => applied.push(new),
                Ok(None) => {}
                Err(error) => {
                    self.connection.execute_batch("ROLLBACK").ok();
                    // What this applied in memory goes too.
                    self.load()?;
                    return Err(error);
                }
            }
        }
        self.connection
            .execute_batch("COMMIT")
            .map_err(|error| error.to_string())?;
        Ok(applied)
    }

    /// Changes applied after position `after` that took effect, oldest first.
    pub fn applied_after(&self, after: u64, limit: usize) -> Vec<Applied> {
        self.read_changes(after, limit, true).unwrap_or_default()
    }

    /// Stores a change and applies it, unless it's known.
    fn record(&mut self, change: Change) -> Result<Option<Applied>, String> {
        let entity_key = (change.kind.clone(), change.id.clone());
        let mut entity = self.entities.get(&entity_key).cloned().unwrap_or_default();
        let took = entity.apply(&change.stamp, &change.fields);
        let inserted = self
            .connection
            .execute(
                "INSERT OR IGNORE INTO changes (millis, counter, device, kind, id, fields, took)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    change.stamp.millis,
                    change.stamp.counter,
                    change.stamp.device,
                    change.kind,
                    change.id,
                    Value::Object(change.fields.clone()).to_string(),
                    Value::Object(took.clone()).to_string(),
                ],
            )
            .map_err(|error| error.to_string())?;
        if inserted == 0 {
            return Ok(None);
        }
        self.observe(&change.stamp);
        self.entities.insert(entity_key, entity);
        let seq = self.connection.last_insert_rowid() as u64;
        self.head = seq;
        Ok(Some(Applied { seq, change, took }))
    }

    fn read_changes(
        &self,
        after: u64,
        limit: usize,
        effective: bool,
    ) -> Result<Vec<Applied>, String> {
        let query = if effective {
            "SELECT seq, millis, counter, device, kind, id, fields, took FROM changes
             WHERE seq > ?1 AND took != '{}' ORDER BY seq LIMIT ?2"
        } else {
            "SELECT seq, millis, counter, device, kind, id, fields, took FROM changes
             WHERE seq > ?1 ORDER BY seq LIMIT ?2"
        };
        let mut statement = self
            .connection
            .prepare_cached(query)
            .map_err(|error| error.to_string())?;
        let limit = i64::try_from(limit).unwrap_or(i64::MAX);
        let rows = statement
            .query_map(params![after as i64, limit], |row| {
                let fields: String = row.get(6)?;
                let took: String = row.get(7)?;
                Ok(Applied {
                    seq: row.get::<_, i64>(0)? as u64,
                    change: Change {
                        stamp: Stamp {
                            millis: row.get(1)?,
                            counter: row.get(2)?,
                            device: row.get(3)?,
                        },
                        kind: row.get(4)?,
                        id: row.get(5)?,
                        fields: object(&fields),
                    },
                    took: object(&took),
                })
            })
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<_, _>>()
            .map_err(|error| error.to_string())
    }

    fn next_stamp(&mut self) -> Stamp {
        let now = now_millis();
        self.clock = if now > self.clock.0 {
            (now, 0)
        } else {
            (self.clock.0, self.clock.1 + 1)
        };
        Stamp {
            millis: self.clock.0,
            counter: self.clock.1,
            device: self.device.clone(),
        }
    }

    /// Moves the clock past a reading from anywhere, so the next edit here is newer than
    /// everything seen.
    fn observe(&mut self, stamp: &Stamp) {
        self.clock = self.clock.max((stamp.millis, stamp.counter));
    }

    /// This device's changes that haven't been shared yet, and the position of the last of
    /// them, to pass to [`Store::exported`] once [`export`] has written them.
    pub fn unexported(&self) -> (Vec<Change>, u64) {
        let shared = meta(&self.connection, "exported")
            .ok()
            .flatten()
            .and_then(|seq| seq.parse().ok())
            .unwrap_or(0);
        let own: Vec<Applied> = self
            .read_changes(shared, usize::MAX, false)
            .unwrap_or_default()
            .into_iter()
            .filter(|applied| applied.change.stamp.device == self.device)
            .collect();
        let up_to = own.last().map_or(shared, |applied| applied.seq);
        (
            own.into_iter().map(|applied| applied.change).collect(),
            up_to,
        )
    }

    /// Notes that this device's changes up to position `up_to` have been shared.
    pub fn exported(&mut self, up_to: u64) -> Result<(), String> {
        set_meta(&self.connection, "exported", &up_to.to_string())
    }

    /// Where reading the other devices' files should start: how far each was read before.
    pub fn read_positions(&self) -> BTreeMap<String, u64> {
        let mut statement = match self
            .connection
            .prepare_cached("SELECT key, value FROM meta WHERE key LIKE 'read:%'")
        {
            Ok(statement) => statement,
            Err(_) => return BTreeMap::new(),
        };
        let rows = statement.query_map([], |row| {
            let key: String = row.get(0)?;
            let value: String = row.get(1)?;
            Ok((key, value))
        });
        rows.into_iter()
            .flatten()
            .flatten()
            .filter_map(|(key, value)| {
                Some((key.strip_prefix("read:")?.to_string(), value.parse().ok()?))
            })
            .collect()
    }

    /// Applies what was read from the other devices' files, and remembers how far each was read.
    pub fn import(&mut self, reads: Vec<PeerRead>) -> Result<Vec<Applied>, String> {
        let mut applied = Vec::new();
        for read in reads {
            applied.extend(self.merge(read.changes)?);
            set_meta(
                &self.connection,
                &format!("read:{}", read.file),
                &read.position.to_string(),
            )?;
        }
        Ok(applied)
    }

    /// A new entity id: eight letters and digits, starting with a letter, never reused.
    pub fn new_id() -> String {
        random_id(8)
    }
}

fn object(text: &str) -> Map<String, Value> {
    match serde_json::from_str(text) {
        Ok(Value::Object(fields)) => fields,
        _ => Map::new(),
    }
}

fn meta(connection: &Connection, key: &str) -> Result<Option<String>, String> {
    connection
        .query_row("SELECT value FROM meta WHERE key = ?1", [key], |row| {
            row.get(0)
        })
        .optional()
        .map_err(|error| error.to_string())
}

fn set_meta(connection: &Connection, key: &str, value: &str) -> Result<(), String> {
    connection
        .execute(
            "INSERT INTO meta (key, value) VALUES (?1, ?2)
             ON CONFLICT (key) DO UPDATE SET value = excluded.value",
            [key, value],
        )
        .map(|_| ())
        .map_err(|error| error.to_string())
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| since.as_millis() as i64)
}

/// Lowercase letters and digits that can't be mistaken for each other, the first a letter.
fn random_id(length: usize) -> String {
    const LETTERS: &[u8] = b"abcdefghjkmnpqrstuvwxyz";
    const ALPHABET: &[u8] = b"abcdefghjkmnpqrstuvwxyz23456789";
    let mut hasher = RandomState::new().build_hasher();
    hasher.write_i64(now_millis());
    let mut bits = hasher.finish();
    (0..length)
        .map(|index| {
            let alphabet = if index == 0 { LETTERS } else { ALPHABET };
            let character = alphabet[(bits % alphabet.len() as u64) as usize] as char;
            bits /= alphabet.len() as u64;
            character
        })
        .collect()
}

/// This device's name in synced data, the same for every app: the computer's name and a few
/// random letters, made once and kept in the suite's folder.
pub fn device_id() -> String {
    let path = dirs::data_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("plain")
        .join("device.json");
    let saved = std::fs::read(&path)
        .ok()
        .and_then(|data| serde_json::from_slice::<Value>(&data).ok())
        .and_then(|saved| saved["id"].as_str().map(str::to_string));
    if let Some(id) = saved {
        return id;
    }
    let name = std::process::Command::new("scutil")
        .args(["--get", "LocalHostName"])
        .output()
        .ok()
        .map(|output| {
            String::from_utf8_lossy(&output.stdout)
                .trim()
                .to_lowercase()
        })
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "mac".into());
    let id = format!("{name}-{}", random_id(4));
    std::fs::create_dir_all(path.parent().expect("the suite's folder has a parent")).ok();
    std::fs::write(&path, serde_json::json!({ "id": id }).to_string()).ok();
    id
}
