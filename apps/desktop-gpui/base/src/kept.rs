//! State that outlives a hot patch. A `static` or thread-local in the app crate is copied into each
//! patch fresh, so a patched function would see an empty outbox or a forgotten flag; one declared
//! with `kept!` or `kept_local!` is held here instead, by its path, and every patch finds the same
//! value. Outside a dev run it costs a lookup the first time it's touched.
//!
//! A kept value's type is its own: a patch that changes it panics on first use, as dx can't patch a
//! type's layout anyway (restart the run).

use std::any::Any;
use std::cell::RefCell;
use std::collections::HashMap;
use std::ops::Deref;
use std::rc::Rc;
use std::sync::{Mutex, OnceLock};

/// Each process-wide value by its path: a cell that's filled the first time it's read.
static ALL: Mutex<Option<HashMap<String, &'static (dyn Any + Send + Sync)>>> = Mutex::new(None);

thread_local! {
    /// Each thread's values by their path.
    static LOCAL: RefCell<HashMap<String, Rc<dyn Any>>> = RefCell::default();
}

/// The cell for `key`, made by `empty` the first time.
fn cell(key: &str, empty: fn() -> &'static (dyn Any + Send + Sync)) -> &'static (dyn Any + Send + Sync) {
    let mut all = ALL.lock().unwrap_or_else(|e| e.into_inner());
    *all.get_or_insert_default().entry(key.to_string()).or_insert_with(empty)
}

/// This thread's value for `key`, made by `make` the first time (outside the borrow, so it may
/// touch other kept values).
fn local(key: &str, make: &dyn Fn() -> Rc<dyn Any>) -> Rc<dyn Any> {
    if let Some(v) = LOCAL.with_borrow(|l| l.get(key).cloned()) {
        return v;
    }
    let v = make();
    LOCAL.with_borrow_mut(|l| l.entry(key.to_string()).or_insert(v).clone())
}

fn changed(key: &str) -> ! {
    panic!("{key} changed its type: restart the run");
}

/// A process-wide value that lasts across hot patches: `kept!`.
pub struct Kept<T: 'static> {
    key: &'static str,
    init: fn() -> T,
    /// Where this copy of the app crate found it.
    found: OnceLock<&'static T>,
}

impl<T: Send + Sync + 'static> Kept<T> {
    #[doc(hidden)]
    pub const fn new(key: &'static str, init: fn() -> T) -> Self {
        Self { key, init, found: OnceLock::new() }
    }
}

impl<T: Send + Sync + 'static> Deref for Kept<T> {
    type Target = T;

    fn deref(&self) -> &T {
        self.found.get_or_init(|| {
            let cell = cell(self.key, || Box::leak(Box::new(OnceLock::<T>::new())));
            let Some(cell) = cell.downcast_ref::<OnceLock<T>>() else { changed(self.key) };
            cell.get_or_init(self.init)
        })
    }
}

/// A value of each thread's that lasts across hot patches: `kept_local!`, read as a
/// thread-local's is.
pub struct KeptLocal<T: 'static> {
    key: &'static str,
    init: fn() -> T,
}

impl<T: 'static> KeptLocal<T> {
    #[doc(hidden)]
    pub const fn new(key: &'static str, init: fn() -> T) -> Self {
        Self { key, init }
    }

    /// Runs `f` with this thread's value.
    pub fn with<R>(&'static self, f: impl FnOnce(&T) -> R) -> R {
        let v = local(self.key, &|| Rc::new((self.init)()));
        let Some(v) = v.downcast_ref::<T>() else { changed(self.key) };
        f(v)
    }
}

/// A `static` that lasts across hot patches, read as the static is:
/// `kept! { static OUTBOX: Mutex<Outbox> = Mutex::new(Outbox::default()); }`.
#[macro_export]
macro_rules! kept {
    ($($(#[$m:meta])* $v:vis static $name:ident: $t:ty = $init:expr;)*) => {$(
        $(#[$m])* $v static $name: $crate::Kept<$t> = $crate::Kept::new(concat!(module_path!(), "::", stringify!($name)), || $init);
    )*};
}

/// A thread-local that lasts across hot patches, read with `with` as one is:
/// `kept_local! { static OPENED: RefCell<HashMap<String, bool>> = RefCell::default(); }`.
#[macro_export]
macro_rules! kept_local {
    ($($(#[$m:meta])* $v:vis static $name:ident: $t:ty = $init:expr;)*) => {$(
        $(#[$m])* $v static $name: $crate::KeptLocal<$t> = $crate::KeptLocal::new(concat!(module_path!(), "::", stringify!($name)), || $init);
    )*};
}
