/// System sounds the suite uses for alerts, rather than bundling its own.
#[derive(Clone, Copy)]
pub enum Sound {
    /// A bright chime, for a finished timer.
    Chime,
}

impl Sound {
    #[cfg(target_os = "macos")]
    fn system_name(self) -> &'static str {
        match self {
            Self::Chime => "Glass",
        }
    }

    /// Plays the sound once, without waiting for it to finish.
    #[cfg(target_os = "macos")]
    pub fn play(self) {
        use objc2_app_kit::NSSound;
        use objc2_foundation::NSString;

        if let Some(sound) = NSSound::soundNamed(&NSString::from_str(self.system_name())) {
            // A sound still playing from the last alert starts over instead of overlapping.
            sound.stop();
            sound.play();
        }
    }

    #[cfg(not(target_os = "macos"))]
    pub fn play(self) {}
}
