use gpui::{
    App, Bounds, Element, ElementId, GlobalElementId, Hitbox, InspectorElementId, InteractiveElement,
    Interactivity, IntoElement, LayoutId, Pixels, StyleRefinement, Styled, Svg, Window, px, svg,
};
use resvg::{tiny_skia, usvg};

use crate::Assets;

/// Icons bundled with the kit, all from Phosphor's bold weight (MIT, see `assets/icons/LICENSE`),
/// @phosphor-icons/core 2.1.1.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Icon {
    Arrow,
    ArrowBendUpLeft,
    ArrowClockwise,
    ArrowElbowDownRight,
    ArrowRight,
    ArrowSquareOut,
    ArrowUp,
    ArrowsInSimple,
    ArrowsOutSimple,
    ArrowsSplit,
    Bell,
    BookOpen,
    Brain,
    Calendar,
    Camera,
    CaretDown,
    CaretLeft,
    CaretRight,
    CaretUp,
    Chat,
    ChatCircle,
    ChatText,
    Chats,
    Check,
    CheckCircle,
    Circle,
    Clock,
    Close,
    CloudSlash,
    Copy,
    Cpu,
    Crop,
    CursorClick,
    Database,
    DotsThree,
    Ellipse,
    Export,
    Eye,
    FileText,
    Fire,
    Fit,
    Flag,
    FlipHorizontal,
    FlipVertical,
    Folder,
    FolderOpen,
    Gear,
    Globe,
    Highlighter,
    Image,
    Lightbulb,
    Lightning,
    Line,
    ListChecks,
    MagnifyingGlass,
    Markup,
    Microphone,
    MicrophoneSlash,
    NotePencil,
    Notebook,
    PaperPlaneTilt,
    Path,
    Pause,
    Pen,
    PencilSimple,
    Play,
    Plus,
    Pointer,
    Printer,
    Pulse,
    PushPin,
    Record,
    Recording,
    Rectangle,
    Redact,
    Redo,
    Reset,
    Resize,
    Robot,
    RotateLeft,
    RotateRight,
    Screen,
    Sidebar,
    Snowflake,
    Speaker,
    SquaresFour,
    Stop,
    Stopwatch,
    TerminalWindow,
    Text,
    Thermometer,
    ThumbsDown,
    ThumbsUp,
    Timer,
    Transcript,
    Trash,
    Tray,
    Undo,
    Warning,
    Window,
    Wrench,
    XCircle,
    ZoomIn,
    ZoomOut,
}

impl Icon {
    pub(crate) fn path(self) -> &'static str {
        match self {
            Self::Arrow => "icons/arrow.svg",
            Self::ArrowBendUpLeft => "icons/arrow-bend-up-left.svg",
            Self::ArrowClockwise => "icons/arrow-clockwise.svg",
            Self::ArrowElbowDownRight => "icons/arrow-elbow-down-right.svg",
            Self::ArrowRight => "icons/arrow-right.svg",
            Self::ArrowSquareOut => "icons/arrow-square-out.svg",
            Self::ArrowUp => "icons/arrow-up.svg",
            Self::ArrowsInSimple => "icons/arrows-in-simple.svg",
            Self::ArrowsOutSimple => "icons/arrows-out-simple.svg",
            Self::ArrowsSplit => "icons/arrows-split.svg",
            Self::Bell => "icons/bell.svg",
            Self::BookOpen => "icons/book-open.svg",
            Self::Brain => "icons/brain.svg",
            Self::Calendar => "icons/calendar.svg",
            Self::Camera => "icons/camera.svg",
            Self::CaretDown => "icons/caret-down.svg",
            Self::CaretLeft => "icons/caret-left.svg",
            Self::CaretRight => "icons/caret-right.svg",
            Self::CaretUp => "icons/caret-up.svg",
            Self::Chat => "icons/chat.svg",
            Self::ChatCircle => "icons/chat-circle.svg",
            Self::ChatText => "icons/chat-text.svg",
            Self::Chats => "icons/chats.svg",
            Self::Check => "icons/check.svg",
            Self::CheckCircle => "icons/check-circle.svg",
            Self::Circle => "icons/circle.svg",
            Self::Clock => "icons/clock.svg",
            Self::Close => "icons/close.svg",
            Self::CloudSlash => "icons/cloud-slash.svg",
            Self::Copy => "icons/copy.svg",
            Self::Cpu => "icons/cpu.svg",
            Self::Crop => "icons/crop.svg",
            Self::CursorClick => "icons/cursor-click.svg",
            Self::Database => "icons/database.svg",
            Self::DotsThree => "icons/dots-three.svg",
            Self::Ellipse => "icons/ellipse.svg",
            Self::Export => "icons/export.svg",
            Self::Eye => "icons/eye.svg",
            Self::FileText => "icons/file-text.svg",
            Self::Fire => "icons/fire.svg",
            Self::Fit => "icons/fit.svg",
            Self::Flag => "icons/flag.svg",
            Self::FlipHorizontal => "icons/flip-horizontal.svg",
            Self::FlipVertical => "icons/flip-vertical.svg",
            Self::Folder => "icons/folder.svg",
            Self::FolderOpen => "icons/folder-open.svg",
            Self::Gear => "icons/gear.svg",
            Self::Globe => "icons/globe.svg",
            Self::Highlighter => "icons/highlighter.svg",
            Self::Image => "icons/image.svg",
            Self::Lightbulb => "icons/lightbulb.svg",
            Self::Lightning => "icons/lightning.svg",
            Self::Line => "icons/line.svg",
            Self::ListChecks => "icons/list-checks.svg",
            Self::MagnifyingGlass => "icons/magnifying-glass.svg",
            Self::Markup => "icons/markup.svg",
            Self::Microphone => "icons/microphone.svg",
            Self::MicrophoneSlash => "icons/microphone-slash.svg",
            Self::NotePencil => "icons/note-pencil.svg",
            Self::Notebook => "icons/notebook.svg",
            Self::PaperPlaneTilt => "icons/paper-plane-tilt.svg",
            Self::Path => "icons/path.svg",
            Self::Pause => "icons/pause.svg",
            Self::Pen => "icons/pen.svg",
            Self::PencilSimple => "icons/pencil-simple.svg",
            Self::Play => "icons/play.svg",
            Self::Plus => "icons/plus.svg",
            Self::Pointer => "icons/pointer.svg",
            Self::Printer => "icons/printer.svg",
            Self::Pulse => "icons/pulse.svg",
            Self::PushPin => "icons/push-pin.svg",
            Self::Record => "icons/record.svg",
            Self::Recording => "icons/recording.svg",
            Self::Rectangle => "icons/rectangle.svg",
            Self::Redact => "icons/redact.svg",
            Self::Redo => "icons/redo.svg",
            Self::Reset => "icons/reset.svg",
            Self::Resize => "icons/resize.svg",
            Self::Robot => "icons/robot.svg",
            Self::RotateLeft => "icons/rotate-left.svg",
            Self::RotateRight => "icons/rotate-right.svg",
            Self::Screen => "icons/screen.svg",
            Self::Sidebar => "icons/sidebar.svg",
            Self::Snowflake => "icons/snowflake.svg",
            Self::Speaker => "icons/speaker.svg",
            Self::SquaresFour => "icons/squares-four.svg",
            Self::Stop => "icons/stop.svg",
            Self::Stopwatch => "icons/stopwatch.svg",
            Self::TerminalWindow => "icons/terminal-window.svg",
            Self::Text => "icons/text.svg",
            Self::Thermometer => "icons/thermometer.svg",
            Self::ThumbsDown => "icons/thumbs-down.svg",
            Self::ThumbsUp => "icons/thumbs-up.svg",
            Self::Timer => "icons/timer.svg",
            Self::Transcript => "icons/transcript.svg",
            Self::Trash => "icons/trash.svg",
            Self::Tray => "icons/tray.svg",
            Self::Undo => "icons/undo.svg",
            Self::Warning => "icons/warning.svg",
            Self::Window => "icons/window.svg",
            Self::Wrench => "icons/wrench.svg",
            Self::XCircle => "icons/x-circle.svg",
            Self::ZoomIn => "icons/zoom-in.svg",
            Self::ZoomOut => "icons/zoom-out.svg",
        }
    }

    /// Rasterizes the icon to square RGBA pixels, for places GPUI doesn't draw, like the menu bar.
    pub fn rgba(self, size: u32) -> Vec<u8> {
        let data = Assets::get(self.path()).expect("icon is embedded").data;
        let tree =
            usvg::Tree::from_data(&data, &usvg::Options::default()).expect("icon is valid SVG");
        let mut pixmap = tiny_skia::Pixmap::new(size, size).expect("icon size is non-zero");
        let scale = size as f32 / tree.size().width();
        resvg::render(
            &tree,
            tiny_skia::Transform::from_scale(scale, scale),
            &mut pixmap.as_mut(),
        );
        pixmap.take()
    }
}

/// A 16px icon, in the color of the text around it unless it's given one
/// (`text_color`).
pub fn icon(icon: Icon) -> IconElement {
    IconElement(svg().path(icon.path()).size(px(16.)).flex_none())
}

/// An icon ([`icon`]). GPUI paints an SVG as a mask in the text color set on
/// the SVG itself, and never in an inherited one, so an icon without its own
/// takes the text's around it as it's painted: it follows its parent's color
/// as that changes on hover, when pressed, or when disabled.
pub struct IconElement(Svg);

impl IntoElement for IconElement {
    type Element = Self;

    fn into_element(self) -> Self::Element {
        self
    }
}

impl Styled for IconElement {
    fn style(&mut self) -> &mut StyleRefinement {
        self.0.style()
    }
}

impl InteractiveElement for IconElement {
    fn interactivity(&mut self) -> &mut Interactivity {
        self.0.interactivity()
    }
}

impl Element for IconElement {
    type RequestLayoutState = <Svg as Element>::RequestLayoutState;
    type PrepaintState = <Svg as Element>::PrepaintState;

    fn id(&self) -> Option<ElementId> {
        Element::id(&self.0)
    }

    fn source_location(&self) -> Option<&'static std::panic::Location<'static>> {
        Element::source_location(&self.0)
    }

    fn request_layout(
        &mut self,
        id: Option<&GlobalElementId>,
        inspector_id: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, Self::RequestLayoutState) {
        self.0.request_layout(id, inspector_id, window, cx)
    }

    fn prepaint(
        &mut self,
        id: Option<&GlobalElementId>,
        inspector_id: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        request_layout: &mut Self::RequestLayoutState,
        window: &mut Window,
        cx: &mut App,
    ) -> Self::PrepaintState {
        self.0.prepaint(id, inspector_id, bounds, request_layout, window, cx)
    }

    fn paint(
        &mut self,
        id: Option<&GlobalElementId>,
        inspector_id: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        request_layout: &mut Self::RequestLayoutState,
        hitbox: &mut Option<Hitbox>,
        window: &mut Window,
        cx: &mut App,
    ) {
        let style = self.0.style();
        if style.text.color.is_none() {
            style.text.color = Some(window.text_style().color);
        }
        self.0.paint(id, inspector_id, bounds, request_layout, hitbox, window, cx);
    }
}
