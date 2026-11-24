mod actions;
mod capture;
mod choose;
mod library;
mod main_window;
mod menu_bar;
mod mix;
mod player;
mod recorder;
mod track;
mod transcript;
mod writer;

use gpui::{
    Action, App, AppContext, ClipboardItem, Context, Entity, KeyBinding, Menu, MenuItem, Task, px,
    size,
};
use kit::{AppInfo, CloseWindow, WindowSetup};

use crate::{
    actions::{
        CopyTranscript, MoveToTrash, Pause, Play, PlayVideo, RecordScreen, RecordWindow,
        RefreshSources, RenameSpeaker, Select, SelectNext, SelectPrevious, SetSource, ShowInFinder,
        ShowNewRecording, SkipBack, SkipForward, StartRecording, StopRecording, ToggleMicrophone,
        TogglePlayback, ToggleRecording, ToggleSystemAudio, Transcribe,
    },
    capture::Source,
    main_window::MainWindow,
    recorder::Recorder,
};

const APP: AppInfo = AppInfo {
    id: "recorder",
    name: "Recorder",
};

fn main() {
    kit::main(APP, |cx| {
        let recorder = cx.new(|cx| {
            let preferences = kit::load(cx, "preferences").unwrap_or_default();
            Recorder::new(preferences, cx)
        });
        cx.observe(&recorder, |recorder, cx| {
            kit::save(cx, "preferences", &recorder.read(cx).preferences);
        })
        .detach();
        kit::report_state(cx, {
            let recorder = recorder.clone();
            move |cx| recorder.read(cx).report()
        });

        start(cx, &recorder, |recorder, action: &StartRecording, cx| {
            let StartRecording {
                source,
                microphone,
                system_audio,
            } = action.clone();
            let chosen = source.map(|choice| recorder.choose(choice, cx));
            cx.spawn(async move |recorder, cx| {
                let source = match chosen {
                    Some(chosen) => Some(chosen.await?),
                    None => None,
                };
                recorder
                    .update(cx, |recorder, cx| {
                        recorder.start(
                            move |preferences| {
                                preferences.source = source.or(preferences.source);
                                preferences.microphone =
                                    microphone.unwrap_or(preferences.microphone);
                                preferences.system_audio =
                                    system_audio.unwrap_or(preferences.system_audio);
                            },
                            cx,
                        )
                    })
                    .map_err(|error| error.to_string())?
                    .await
            })
        });
        start(cx, &recorder, |recorder, _: &StopRecording, cx| {
            recorder.stop(cx)
        });
        start(cx, &recorder, |recorder, _: &ToggleRecording, cx| {
            if !recorder.is_idle() {
                return recorder.stop(cx);
            }
            let started = recorder.start(|_| {}, cx);
            // Started from the menu bar or a shortcut, a recording that can't start would fail
            // unseen, so the window comes up showing why.
            cx.spawn(async move |_, cx| {
                let result = started.await;
                if result.is_err() {
                    cx.update(kit::show_main_window);
                }
                result
            })
        });
        start(cx, &recorder, |recorder, _: &RefreshSources, cx| {
            recorder.refresh_sources(cx)
        });
        start(cx, &recorder, |recorder, action: &Transcribe, cx| {
            recorder.transcribe(action.id, cx)
        });
        start(cx, &recorder, |recorder, _: &RecordWindow, cx| {
            // The front window is the likeliest one to record. The list is refreshed first, so
            // it's the front window now.
            let refreshed = recorder.refresh_sources(cx);
            cx.spawn(async move |recorder, cx| {
                refreshed.await?;
                recorder
                    .update(cx, |recorder, cx| {
                        let window = recorder
                            .sources
                            .windows
                            .first()
                            .ok_or("There are no windows to record")?;
                        recorder.preferences.source = Some(Source::Window(window.id));
                        cx.notify();
                        Ok(())
                    })
                    .map_err(|error| error.to_string())?
            })
        });

        start(cx, &recorder, |recorder, action: &SetSource, cx| {
            let chosen = recorder.choose(action.source.clone(), cx);
            cx.spawn(async move |recorder, cx| {
                let source = chosen.await?;
                recorder
                    .update(cx, |recorder, cx| {
                        recorder.preferences.source = Some(source);
                        cx.notify();
                    })
                    .map_err(|error| error.to_string())
            })
        });
        handle(cx, &recorder, |recorder, _: &RecordScreen| {
            if let Some(Source::Window(_)) = recorder.preferences.source {
                recorder.preferences.source = None;
            }
            Ok(())
        });
        handle(cx, &recorder, |recorder, action: &ToggleMicrophone| {
            let preferences = &mut recorder.preferences;
            preferences.microphone = action.on.unwrap_or(!preferences.microphone);
            Ok(())
        });
        handle(cx, &recorder, |recorder, action: &ToggleSystemAudio| {
            let preferences = &mut recorder.preferences;
            preferences.system_audio = action.on.unwrap_or(!preferences.system_audio);
            Ok(())
        });
        handle(cx, &recorder, |recorder, action: &Select| {
            recorder.select(Some(action.id))
        });
        handle(cx, &recorder, |recorder, _: &ShowNewRecording| {
            recorder.select(None)
        });
        handle(cx, &recorder, |recorder, _: &SelectPrevious| {
            recorder.select_by_offset(-1);
            Ok(())
        });
        handle(cx, &recorder, |recorder, _: &SelectNext| {
            recorder.select_by_offset(1);
            Ok(())
        });
        handle(cx, &recorder, |recorder, action: &RenameSpeaker| {
            recorder.rename_speaker(action.id, &action.speaker, &action.name)
        });
        handle(cx, &recorder, |recorder, action: &MoveToTrash| {
            recorder.move_to_trash(action.id)
        });
        handle(cx, &recorder, |recorder, action: &Play| {
            let from = action.from.as_deref().map(transcript::moment).transpose()?;
            recorder.play(action.id, from)
        });
        handle(cx, &recorder, |recorder, _: &Pause| {
            recorder.pause();
            Ok(())
        });
        handle(cx, &recorder, |recorder, _: &TogglePlayback| {
            recorder.toggle_playback()
        });
        handle(cx, &recorder, |recorder, _: &SkipBack| {
            recorder.skip(-5.);
            Ok(())
        });
        handle(cx, &recorder, |recorder, _: &SkipForward| {
            recorder.skip(5.);
            Ok(())
        });

        cx.on_action({
            let recorder = recorder.clone();
            move |_: &PlayVideo, cx| {
                if let Some(recording) = selected(&recorder, cx) {
                    cx.open_with_system(&recording.files().video);
                }
            }
        });
        cx.on_action({
            let recorder = recorder.clone();
            move |_: &ShowInFinder, cx| {
                if let Some(recording) = selected(&recorder, cx) {
                    cx.reveal_path(&recording.files().video);
                }
            }
        });
        cx.on_action({
            let recorder = recorder.clone();
            move |_: &CopyTranscript, cx| {
                let markdown = selected(&recorder, cx).and_then(|recording| {
                    let lines = recording.transcript.as_ref()?;
                    Some(transcript::markdown(
                        &recording.title,
                        &recording.subtitle(),
                        lines,
                    ))
                });
                if let Some(markdown) = markdown {
                    cx.write_to_clipboard(ClipboardItem::new_string(markdown));
                }
            }
        });

        cx.bind_keys(key_bindings());
        set_menus(cx);
        kit::set_main_window(cx, {
            let recorder = recorder.clone();
            move |cx| {
                let recorder = recorder.clone();
                kit::open_window_with(
                    cx,
                    WindowSetup {
                        title: APP.name,
                        size: size(px(920.), px(720.)),
                        min_size: size(px(760.), px(560.)),
                        focus: true,
                    },
                    |window, cx| MainWindow::new(recorder, window, cx),
                );
            }
        });
        menu_bar::install(recorder, cx);
    });
}

/// The recording shown in the window, if any.
fn selected(recorder: &Entity<Recorder>, cx: &App) -> Option<library::Recording> {
    let recorder = recorder.read(cx);
    recorder
        .selected
        .and_then(|id| recorder.recording(id))
        .cloned()
}

/// Every shortcut. Single keys only apply outside text fields.
fn key_bindings() -> Vec<KeyBinding> {
    let window = Some("Recorder && !TextField");
    vec![
        KeyBinding::new("cmd-r", ToggleRecording, None),
        KeyBinding::new("cmd-n", ShowNewRecording, None),
        KeyBinding::new("cmd-1", RecordScreen, None),
        KeyBinding::new("cmd-2", RecordWindow, None),
        KeyBinding::new("cmd-shift-m", ToggleMicrophone::default(), None),
        KeyBinding::new("cmd-shift-a", ToggleSystemAudio::default(), None),
        KeyBinding::new("cmd-t", Transcribe::default(), None),
        KeyBinding::new("cmd-shift-c", CopyTranscript, None),
        KeyBinding::new("cmd-o", PlayVideo, None),
        KeyBinding::new("space", TogglePlayback, window),
        KeyBinding::new("left", SkipBack, window),
        KeyBinding::new("right", SkipForward, window),
        KeyBinding::new("cmd-alt-r", ShowInFinder, None),
        KeyBinding::new("cmd-backspace", MoveToTrash::default(), window),
        KeyBinding::new("up", SelectPrevious, window),
        KeyBinding::new("down", SelectNext, window),
        KeyBinding::new("cmd-shift-r", RefreshSources, None),
    ]
}

fn set_menus(cx: &mut App) {
    kit::set_menus(
        cx,
        APP.name,
        [
            Menu::new("File").items([
                MenuItem::action("New Recording", ShowNewRecording),
                MenuItem::separator(),
                MenuItem::action("Open Video", PlayVideo),
                MenuItem::action("Show in Finder", ShowInFinder),
                MenuItem::action("Move to Trash", MoveToTrash::default()),
                MenuItem::separator(),
                MenuItem::action("Close Window", CloseWindow),
            ]),
            Menu::new("Edit").items([MenuItem::action("Copy Transcript", CopyTranscript)]),
            Menu::new("Playback").items([
                MenuItem::action("Play or Pause", TogglePlayback),
                MenuItem::action("Back 5 Seconds", SkipBack),
                MenuItem::action("Forward 5 Seconds", SkipForward),
            ]),
            Menu::new("Record").items([
                MenuItem::action("Start or Stop Recording", ToggleRecording),
                MenuItem::separator(),
                MenuItem::action("Record Screen", RecordScreen),
                MenuItem::action("Record Window", RecordWindow),
                MenuItem::action("Refresh Windows", RefreshSources),
                MenuItem::separator(),
                MenuItem::action("Microphone", ToggleMicrophone::default()),
                MenuItem::action("System Audio", ToggleSystemAudio::default()),
                MenuItem::separator(),
                MenuItem::action("Transcribe Again", Transcribe::default()),
            ]),
        ],
    );
}

/// Handles an action app-wide by updating the recorder, so it works the same from the
/// keyboard, a click, the menu bar or an agent. An error fails the agent call that sent it.
fn handle<A: Action>(
    cx: &mut App,
    recorder: &Entity<Recorder>,
    update: impl Fn(&mut Recorder, &A) -> Result<(), String> + 'static,
) {
    let recorder = recorder.clone();
    cx.on_action(move |action: &A, cx| {
        let result = recorder.update(cx, |recorder, cx| {
            cx.notify();
            update(recorder, action)
        });
        if let Err(error) = result {
            kit::reject(cx, error);
        }
    });
}

/// Handles an action that starts work taking a while, like starting to record. An agent call
/// that sent it hears back once the work is done.
fn start<A: Action>(
    cx: &mut App,
    recorder: &Entity<Recorder>,
    begin: impl Fn(&mut Recorder, &A, &mut Context<Recorder>) -> Task<Result<(), String>> + 'static,
) {
    let recorder = recorder.clone();
    cx.on_action(move |action: &A, cx| {
        let work = recorder.update(cx, |recorder, cx| begin(recorder, action, cx));
        kit::finish_before_replying(cx, work);
    });
}
