//! Quick decisions by a fast model. Apps use it to read what people type the way they'd say it,
//! like "small enough to email" for a size, when their own parser can't.

use std::{
    collections::HashMap,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

use schemars::JsonSchema;
use serde::{Deserialize, de::DeserializeOwned};
use serde_json::{Value, json};
use ureq::Agent;

use crate::{gateway::GATEWAY, keys::Key};

/// Fast enough to wait on while typing (about a second) and good at reading intent. Chosen by
/// timing the gateway's small models on typed sizes, 2026-10-19.
pub const DECISION_MODEL: &str = "google/gemini-3.5-flash-lite";

/// How long an answer is reused for the same question, so asking again, like a live preview
/// followed by Enter, is instant.
const REMEMBER: Duration = Duration::from_secs(10 * 60);

/// Recent replies by task and input, with when they came.
type Answers = Mutex<HashMap<(String, String), (Instant, String)>>;

fn answers() -> &'static Answers {
    static ANSWERS: OnceLock<Answers> = OnceLock::new();
    ANSWERS.get_or_init(Answers::default)
}

/// What the model answers: a value, or why it couldn't give one.
#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum Reply<T> {
    Answer(T),
    Unclear(String),
}

/// Asks the decision model to read `input` as a `T`. `task` says what the input is for and
/// gives the context needed, like the size of the image being resized. `T`'s JSON schema,
/// doc comments included, tells the model what shapes it can answer with. Fails with the
/// model's reason when it can't tell what was meant. Blocks for about a second, so call it off
/// the main thread. The same question asked again within a few minutes gets the same answer
/// right away.
pub fn decide<T: DeserializeOwned + JsonSchema>(
    key: &Key,
    task: &str,
    input: &str,
) -> Result<T, String> {
    let question = (task.to_string(), input.trim().to_string());
    let remembered = answers().lock().ok().and_then(|answers| {
        answers
            .get(&question)
            .filter(|(at, _)| at.elapsed() < REMEMBER)
            .map(|(_, content)| content.clone())
    });
    if let Some(content) = remembered {
        return read(&content);
    }
    let schema = serde_json::to_string(&schemars::schema_for!(T)).expect("schemas are JSON");
    let instructions = format!(
        "{task}\n\nAnswer with a JSON object only, in one of two shapes:\n\
         {{\"answer\": <a value matching the schema below>}}\n\
         {{\"unclear\": \"<what's missing, in a few plain words>\"}}\n\
         Pick the most likely meaning when there is one.\n\nSchema:\n{schema}"
    );
    let body = json!({
        "model": DECISION_MODEL,
        "messages": [
            { "role": "system", "content": instructions },
            { "role": "user", "content": input },
        ],
        "temperature": 0,
        "response_format": { "type": "json_object" },
    });
    let agent: Agent = Agent::config_builder()
        .http_status_as_error(false)
        .timeout_global(Some(Duration::from_secs(15)))
        .build()
        .into();
    let mut response = agent
        .post(format!("{GATEWAY}/v1/chat/completions"))
        .header("Authorization", format!("Bearer {}", key.value()))
        .send_json(&body)
        .map_err(|error| format!("Couldn't reach the AI Gateway: {error}"))?;
    let reply: Value = response
        .body_mut()
        .read_json()
        .map_err(|error| format!("The AI Gateway's reply didn't make sense: {error}"))?;
    if !response.status().is_success() {
        let message = reply["error"]["message"].as_str().unwrap_or("it failed");
        return Err(format!("The AI Gateway couldn't answer: {message}"));
    }
    let content = reply["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or_default()
        .to_string();
    if let Ok(mut answers) = answers().lock() {
        answers.retain(|_, (at, _)| at.elapsed() < REMEMBER);
        answers.insert(question, (Instant::now(), content.clone()));
    }
    read(&content)
}

/// The value in the model's reply. Tolerates the reply being wrapped in a Markdown code block.
fn read<T: DeserializeOwned>(content: &str) -> Result<T, String> {
    let json = content
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```");
    match serde_json::from_str(json) {
        Ok(Reply::Answer(value)) => Ok(value),
        Ok(Reply::Unclear(reason)) => Err(capitalized(&reason)),
        Err(_) => Err("Couldn't tell what that means".into()),
    }
}

fn capitalized(text: &str) -> String {
    let mut characters = text.trim().chars();
    characters
        .next()
        .map(|first| first.to_uppercase().chain(characters).collect())
        .unwrap_or_default()
}
