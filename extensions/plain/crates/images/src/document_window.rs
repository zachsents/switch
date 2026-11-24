//! A document's window: the folder's images in a list on the left, the shown image in the
//! middle with a toolbar above it and its details below, and the export settings on the right
//! when they're open. It only displays the document; every change goes through an action that
//! agents can call too.

mod crop_words;
mod marking;

use std::{ops::Range, path::PathBuf, sync::Arc, time::Duration};

use gpui::{
    Action, AnyElement, App, AppContext, ClickEvent, Context, Entity, FocusHandle, Focusable,
    Global, IntoElement, ParentElement, Pixels, Point, PromptLevel, Render, ScrollStrategy,
    SharedString, Styled, Subscription, Task, UniformListScrollHandle, Window, WindowHandle, div,
    img, prelude::*, px, size, uniform_list,
};
use kit::{
    ActiveTheme, Button, ButtonVariant, Grid, GridCell, Icon, StyledExt, TextField, TextFieldEvent,
    WindowSetup, icon, text,
};

use crate::{
    ASPECTS, QUALITIES,
    actions::{
        ActualSize, ApplyCrop, CancelCrop, ChooseAll, ChooseThrough, ClearCrop, Close, Copy,
        Direction, EditExportSize, EditSize, Export, Flip, NextCropHandle, NudgeCrop, OpenDialog,
        PreviousCropHandle, Redo, Resize, Rotate, SetCrop, SetExportFormat, SetExportQuality,
        SetExportSize, ShowImage, ShowInFinder, ToggleChosen, ToggleCrop, ToggleExport,
        ToggleMarkup, ToggleSidebar, Undo, ZoomIn, ZoomOut, ZoomTo, ZoomToFit,
    },
    canvas::{Editing, Enlarged, LastPlacement, Picture, Placement, SharedOverlays, Zoom},
    crop::{Aspect, Crop, Handle, Rect},
    document::{Document, ExportFormat, Info, Picture as Shown, file_name},
    edits::{FlipDirection, Orientation, Turn},
    library,
    markup::{Style, Tool},
    picture::{self, Textures},
    render,
    size::Size,
    thumbnails::Thumbnails,
};

/// The thumbnails every window's list shares.
pub struct SharedThumbnails(pub Entity<Thumbnails>);

impl Global for SharedThumbnails {}

pub struct DocumentWindow {
    document: Entity<Document>,
    thumbnails: Entity<Thumbnails>,
    focus_handle: FocusHandle,
    sidebar: bool,
    /// The sidebar's list of images.
    list: UniformListScrollHandle,
    export_panel: bool,
    zoom: Zoom,
    /// Screen pixels per point where the window was last drawn, for reporting zoom.
    screen_scale: f32,
    placement: LastPlacement,
    enlarged: Enlarged,
    textures: Option<Textures>,
    /// The image, turns and mirroring textures are being made for, so they aren't started
    /// twice.
    making: Option<(PathBuf, Orientation)>,
    /// The image the window showed last, to notice another being shown.
    shown: Option<PathBuf>,
    crop_editor: Option<CropEditor>,
    size_editor: Option<SizeEditor>,
    panning: Option<Pan>,
    /// Whether the markup tools are showing.
    markup: bool,
    tool: Tool,
    style: Style,
    /// The chosen mark, by its place in the shown image's marks.
    selected: Option<usize>,
    drawing: Option<marking::Drawing>,
    moving: Option<marking::Moving>,
    adding: Option<marking::Adding>,
    text_editor: Option<marking::TextEditor>,
    overlays: SharedOverlays,
    _subscriptions: Vec<Subscription>,
}

/// Cropping in progress over the picture. The crop itself is in the document, which changes
/// with every edit so agents see it too; this holds what only the window needs.
struct CropEditor {
    path: PathBuf,
    /// The crop from before, put back by Cancel.
    before: Option<Crop>,
    /// What the arrow keys move.
    handle: Handle,
    drag: Option<Drag>,
    /// The crop being typed in words.
    words: Option<crop_words::CropWords>,
}

/// A crop handle being dragged. The crop follows the pointer here and is saved to the document
/// when the button is released, rather than on every move.
#[derive(Clone, Copy)]
struct Drag {
    handle: Handle,
    from: Rect,
    start: Point<Pixels>,
    /// Points per image pixel.
    scale: f32,
    rect: Rect,
}

/// The picture being dragged around while zoomed in.
#[derive(Clone, Copy)]
struct Pan {
    start: Point<Pixels>,
    from: (f32, f32),
    scale: f32,
}

/// A size being typed in place.
struct SizeEditor {
    input: Entity<TextField>,
    /// Whether it's the size exports are scaled to, rather than the image's.
    export: bool,
    /// What the decision model made of text the parser couldn't read.
    understood: Option<(String, Result<Size, String>)>,
    /// Asks the decision model about the text once typing pauses.
    reading: Option<Task<()>>,
    _events: Subscription,
    /// Redraws the window as the text changes, for the size preview.
    _changes: Subscription,
}

impl SizeEditor {
    /// The size the typed text means, once known.
    fn size(&self, cx: &App) -> Option<Result<Size, String>> {
        let text = self.input.read(cx).text().trim();
        match Size::parse(text) {
            Ok(size) => Some(Ok(size)),
            Err(_) => self
                .understood
                .as_ref()
                .filter(|(understood, _)| understood == text)
                .map(|(_, size)| size.clone()),
        }
    }
}

impl DocumentWindow {
    /// Opens a window for `document`. `focus` brings it to the front, which windows opened for
    /// agents don't.
    pub fn open(document: Entity<Document>, focus: bool, cx: &mut App) -> WindowHandle<Self> {
        let title = document.read(cx).folder_name();
        kit::open_window_with(
            cx,
            WindowSetup {
                title: &title,
                size: size(px(1080.), px(720.)),
                min_size: size(px(640.), px(420.)),
                focus,
            },
            |window, cx| Self::new(document, window, cx),
        )
    }

    fn new(document: Entity<Document>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let focus_handle = cx.focus_handle();
        window.focus(&focus_handle, cx);
        let thumbnails = cx.global::<SharedThumbnails>().0.clone();
        let id = document.read(cx).id();
        window.on_window_should_close(cx, {
            let document = document.clone();
            move |window, cx| should_close(&document, window, cx)
        });
        let subscriptions = vec![
            cx.observe_in(&document, window, |this, _, window, cx| {
                this.document_changed(window, cx)
            }),
            cx.observe(&thumbnails, |_, _, cx| cx.notify()),
            cx.observe_window_activation(window, move |this, window, cx| {
                if window.is_window_active() {
                    library::activated(id, cx);
                    this.document
                        .update(cx, |document, cx| document.refresh(cx));
                }
            }),
            cx.on_release(move |_, cx| library::remove(id, cx)),
        ];
        let mut this = Self {
            document,
            thumbnails,
            focus_handle,
            sidebar: true,
            list: UniformListScrollHandle::new(),
            export_panel: false,
            zoom: Zoom::default(),
            screen_scale: window.scale_factor(),
            placement: LastPlacement::default(),
            enlarged: Enlarged::default(),
            textures: None,
            making: None,
            shown: None,
            crop_editor: None,
            size_editor: None,
            panning: None,
            markup: false,
            tool: Tool::Select,
            style: Style::default(),
            selected: None,
            drawing: None,
            moving: None,
            adding: None,
            text_editor: None,
            overlays: SharedOverlays::default(),
            _subscriptions: subscriptions,
        };
        this.document_changed(window, cx);
        this
    }

    fn id(&self, cx: &App) -> u64 {
        self.document.read(cx).id()
    }

    /// Follows the document: the window's title, its edited dot and proxy icon, the picture's
    /// textures, cropping, which ends when its image is no longer shown, and the sidebar, which
    /// scrolls to keep the shown image in view.
    fn document_changed(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let document = self.document.read(cx);
        let current = document.current().map(PathBuf::from);
        let title = current
            .as_deref()
            .map_or_else(|| document.folder_name(), file_name);
        window.set_window_title(&title);
        window.set_window_edited(!document.unsaved().is_empty());
        window.set_document_path(current.as_deref());
        let image_changed = current != self.shown;
        if image_changed {
            if let Some(index) = current
                .as_ref()
                .and_then(|current| document.files().iter().position(|file| file == current))
            {
                // Centered the first time, then only when it's out of view, so the list doesn't
                // move under a click.
                if self.shown.is_none() {
                    self.list
                        .scroll_to_item_strict(index, ScrollStrategy::Center);
                } else {
                    self.list.scroll_to_item(index, ScrollStrategy::Center);
                }
            }
            self.shown = current.clone();
            self.zoom = Zoom::default();
            self.size_editor.take_if(|editor| !editor.export);
        }
        let gone = self.crop_editor.as_ref().is_some_and(|editor| {
            document
                .loaded()
                .is_none_or(|loaded| loaded.path != editor.path)
        });
        if gone {
            self.crop_editor = None;
        }
        self.marks_changed(image_changed, window, cx);
        self.update_textures(window, cx);
        cx.notify();
    }

    /// Makes the textures for the shown image, turned the way its edits say. Turning reuses the
    /// small copy right away, so the picture never shows the old way round.
    fn update_textures(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let document = self.document.read(cx);
        let Some(loaded) = document.loaded().cloned() else {
            return;
        };
        let edits = document.edits();
        let orientation = edits.orientation();
        if self
            .textures
            .as_ref()
            .is_some_and(|textures| textures.matches(&loaded.path, orientation))
        {
            return;
        }
        let key = (loaded.path.clone(), orientation);
        if self.making.as_ref() == Some(&key) {
            return;
        }
        self.making = Some(key.clone());
        let (turned_width, turned_height) =
            edits.turned_size(loaded.info.width, loaded.info.height);
        // Same image turned differently: turn the small copy now.
        let reusable = self
            .textures
            .as_ref()
            .filter(|textures| textures.path == loaded.path)
            .map(|textures| textures.base.clone());
        if let Some(base) = reusable {
            let small = picture::render_image(render::orient(&base, orientation));
            self.replace_textures(
                Textures {
                    path: loaded.path.clone(),
                    base,
                    orientation,
                    width: turned_width,
                    height: turned_height,
                    small,
                    full: None,
                },
                window,
            );
        }
        let image = loaded.image.clone();
        let make_small = cx.background_spawn({
            let image = image.clone();
            async move {
                let base = Arc::new(picture::base(&image));
                let small = picture::render_image(render::orient(&base, orientation));
                (base, small)
            }
        });
        let make_full = cx.background_spawn(async move {
            picture::render_image(picture::full(&image, orientation))
        });
        let needs_small = self
            .textures
            .as_ref()
            .is_none_or(|textures| !textures.matches(&loaded.path, orientation));
        cx.spawn_in(window, async move |this, cx| {
            if needs_small {
                let (base, small) = make_small.await;
                this.update_in(cx, |this, window, cx| {
                    if this.making.as_ref() == Some(&key) {
                        this.replace_textures(
                            Textures {
                                path: key.0.clone(),
                                base,
                                orientation: key.1,
                                width: turned_width,
                                height: turned_height,
                                small,
                                full: None,
                            },
                            window,
                        );
                        cx.notify();
                    }
                })
                .ok();
            }
            let full = make_full.await;
            this.update_in(cx, |this, _, cx| {
                if this.making.as_ref() == Some(&key) {
                    if let Some(textures) = &mut this.textures {
                        textures.full = Some(full);
                    }
                    this.making = None;
                    cx.notify();
                }
            })
            .ok();
        })
        .detach();
    }

    /// Swaps in new textures, freeing the old ones' memory on the graphics card.
    fn replace_textures(&mut self, textures: Textures, window: &mut Window) {
        if let Some(old) = self.textures.replace(textures) {
            window.drop_image(old.small).ok();
            if let Some(full) = old.full {
                window.drop_image(full).ok();
            }
        }
    }

    /// The image being cropped: its crop (the whole image when it has none) and the turned
    /// image's size.
    fn crop_target(&self, cx: &App) -> Option<(Crop, (u32, u32))> {
        let editor = self.crop_editor.as_ref()?;
        let document = self.document.read(cx);
        let loaded = document
            .loaded()
            .filter(|loaded| loaded.path == editor.path)?;
        let edits = document.edits();
        let (width, height) = edits.turned_size(loaded.info.width, loaded.info.height);
        let crop = edits.crop.unwrap_or(Crop {
            rect: Rect::whole(width, height),
            aspect: Aspect::Free,
        });
        Some((crop, (width, height)))
    }

    /// Dispatches an agent action for this window's document.
    fn dispatch(&self, action: Box<dyn Action>, window: &mut Window, cx: &mut App) {
        window.dispatch_action(action, cx);
    }

    fn toggle_crop(&mut self, _: &ToggleCrop, window: &mut Window, cx: &mut Context<Self>) {
        if self.crop_editor.is_some() {
            return self.apply_crop(&ApplyCrop, window, cx);
        }
        let document = self.document.read(cx);
        let Some(loaded) = document.loaded() else {
            return;
        };
        self.crop_editor = Some(CropEditor {
            path: loaded.path.clone(),
            before: document.edits().crop,
            handle: Handle::Whole,
            drag: None,
            words: None,
        });
        self.selected = None;
        self.text_editor = None;
        self.zoom = Zoom::default();
        cx.notify();
    }

    fn apply_crop(&mut self, _: &ApplyCrop, window: &mut Window, cx: &mut Context<Self>) {
        self.end_drag(window, cx);
        self.crop_editor = None;
        self.zoom = Zoom::default();
        cx.notify();
    }

    fn cancel_crop(&mut self, _: &CancelCrop, window: &mut Window, cx: &mut Context<Self>) {
        let Some(CropEditor { before, .. }) = self.crop_editor.take() else {
            return;
        };
        let document = Some(self.id(cx));
        if self.document.read(cx).edits().crop != before {
            let restore = match before {
                Some(crop) => SetCrop {
                    document,
                    ..SetCrop::exactly(crop)
                }
                .boxed_clone(),
                None => ClearCrop { document }.boxed_clone(),
            };
            self.dispatch(restore, window, cx);
        }
        self.zoom = Zoom::default();
        cx.notify();
    }

    fn step_crop_handle(&mut self, offset: isize, cx: &mut Context<Self>) {
        if let Some(editor) = &mut self.crop_editor {
            editor.handle = editor.handle.step(offset);
            cx.notify();
        }
    }

    fn next_crop_handle(&mut self, _: &NextCropHandle, _: &mut Window, cx: &mut Context<Self>) {
        self.step_crop_handle(1, cx);
    }

    fn previous_crop_handle(
        &mut self,
        _: &PreviousCropHandle,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.step_crop_handle(-1, cx);
    }

    /// Moves the chosen handle a pixel, or a hundredth of the image's longer side (at least
    /// ten pixels) when fast. Pixels are the image's, so a press can move less than a point on
    /// screen; the details line shows the change.
    fn nudge_crop(&mut self, action: &NudgeCrop, window: &mut Window, cx: &mut Context<Self>) {
        let Some((crop, (width, height))) = self.crop_target(cx) else {
            return;
        };
        let Some(editor) = self
            .crop_editor
            .as_ref()
            .filter(|editor| editor.drag.is_none())
        else {
            return;
        };
        let step = if action.fast {
            f64::from((width.max(height) / 100).max(10))
        } else {
            1.
        };
        let (dx, dy) = match action.direction {
            Direction::Left => (-step, 0.),
            Direction::Right => (step, 0.),
            Direction::Up => (0., -step),
            Direction::Down => (0., step),
        };
        let ratio = crop.aspect.ratio_on(width, height);
        let rect = crop
            .rect
            .dragged(editor.handle, dx, dy, ratio, width, height);
        if rect != crop.rect {
            let nudged = SetCrop {
                document: Some(self.id(cx)),
                ..SetCrop::exactly(Crop { rect, ..crop })
            };
            self.dispatch(nudged.boxed_clone(), window, cx);
        }
    }

    fn start_drag(
        &mut self,
        handle: Handle,
        start: Point<Pixels>,
        scale: f32,
        cx: &mut Context<Self>,
    ) {
        let Some((crop, _)) = self.crop_target(cx) else {
            return;
        };
        if let Some(editor) = &mut self.crop_editor {
            editor.handle = handle;
            editor.drag = Some(Drag {
                handle,
                from: crop.rect,
                start,
                scale,
                rect: crop.rect,
            });
            cx.notify();
        }
    }

    fn start_pan(&mut self, start: Point<Pixels>, placement: Placement, cx: &mut Context<Self>) {
        self.panning = Some(Pan {
            start,
            from: placement.center,
            scale: placement.scale,
        });
        cx.notify();
    }

    /// Follows the pointer while a mark, a crop handle or the picture is dragged.
    pub fn drag_to(
        &mut self,
        position: Point<Pixels>,
        placement: Placement,
        cx: &mut Context<Self>,
    ) {
        if self.drag_marks(position, placement, cx) {
            return;
        }
        if let Some(pan) = self.panning {
            let offset = position - pan.start;
            self.zoom = Zoom {
                scale: Some(pan.scale),
                center: Some((
                    pan.from.0 - f32::from(offset.x) / pan.scale,
                    pan.from.1 - f32::from(offset.y) / pan.scale,
                )),
            };
            cx.notify();
            return;
        }
        let Some((crop, (width, height))) = self.crop_target(cx) else {
            return;
        };
        let Some(drag) = self
            .crop_editor
            .as_mut()
            .and_then(|editor| editor.drag.as_mut())
        else {
            return;
        };
        let dx = f64::from(f32::from(position.x - drag.start.x) / drag.scale);
        let dy = f64::from(f32::from(position.y - drag.start.y) / drag.scale);
        let ratio = crop.aspect.ratio_on(width, height);
        drag.rect = drag.from.dragged(drag.handle, dx, dy, ratio, width, height);
        cx.notify();
    }

    /// Saves where a drag left a mark or the crop, or ends dragging the picture.
    pub fn end_drag(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.finish_marks(window, cx);
        if self.panning.take().is_some() {
            cx.notify();
        }
        let target = self.crop_target(cx);
        let Some(drag) = self
            .crop_editor
            .as_mut()
            .and_then(|editor| editor.drag.take())
        else {
            return;
        };
        if let Some((crop, _)) = target.filter(|_| drag.rect != drag.from) {
            let dragged = SetCrop {
                document: Some(self.id(cx)),
                ..SetCrop::exactly(Crop {
                    rect: drag.rect,
                    ..crop
                })
            };
            self.dispatch(dragged.boxed_clone(), window, cx);
        }
        cx.notify();
    }

    /// Zooms by `factor` keeping the image point under `at` where it is. Zooming out past
    /// fitting fits.
    pub fn zoom_by(
        &mut self,
        factor: f32,
        at: Point<Pixels>,
        placement: Placement,
        cx: &mut Context<Self>,
    ) {
        let scale = (placement.scale * factor).min(Placement::most());
        self.zoom = if scale <= placement.fit * 1.001 {
            Zoom::default()
        } else {
            placement.zoom_keeping(placement.image_point(at), at, scale)
        };
        cx.notify();
    }

    /// Moves the picture by `delta` points when zoomed in.
    pub fn pan_by(&mut self, delta: Point<Pixels>, placement: Placement, cx: &mut Context<Self>) {
        if placement.scale <= placement.fit * 1.001 {
            return;
        }
        self.zoom = Zoom {
            scale: Some(placement.scale),
            center: Some((
                placement.center.0 - f32::from(delta.x) / placement.scale,
                placement.center.1 - f32::from(delta.y) / placement.scale,
            )),
        };
        cx.notify();
    }

    /// Double-clicking shows the image at actual size around the point clicked, or fits it
    /// again.
    fn toggle_zoom_at(
        &mut self,
        at: Point<Pixels>,
        placement: Placement,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let actual = 1. / window.scale_factor();
        if placement.scale > placement.fit * 1.001 {
            self.zoom = Zoom::default();
        } else {
            let scale = actual.max(placement.fit * 2.);
            self.zoom = placement.zoom_keeping(placement.image_point(at), at, scale);
        }
        cx.notify();
    }

    /// Zooms around the middle of the picture, for commands without a pointer.
    fn zoom_centered(&mut self, scale: impl FnOnce(Placement) -> f32, cx: &mut Context<Self>) {
        let Some(placement) = self.placement.get() else {
            return;
        };
        let middle = placement.bounds.center();
        let factor = scale(placement) / placement.scale;
        self.zoom_by(factor, middle, placement, cx);
    }

    fn zoom_in(&mut self, _: &ZoomIn, _: &mut Window, cx: &mut Context<Self>) {
        self.zoom_centered(|placement| placement.scale * 1.5, cx);
    }

    fn zoom_out(&mut self, _: &ZoomOut, _: &mut Window, cx: &mut Context<Self>) {
        self.zoom_centered(|placement| placement.scale / 1.5, cx);
    }

    fn zoom_to_fit(&mut self, _: &ZoomToFit, _: &mut Window, cx: &mut Context<Self>) {
        self.zoom = Zoom::default();
        cx.notify();
    }

    fn actual_size(&mut self, _: &ActualSize, window: &mut Window, cx: &mut Context<Self>) {
        let actual = 1. / window.scale_factor();
        self.zoom_centered(|_| actual, cx);
    }

    fn toggle_sidebar(&mut self, _: &ToggleSidebar, _: &mut Window, cx: &mut Context<Self>) {
        self.sidebar = !self.sidebar;
        cx.notify();
    }

    fn toggle_export(&mut self, _: &ToggleExport, _: &mut Window, cx: &mut Context<Self>) {
        self.export_panel = !self.export_panel;
        cx.notify();
    }

    /// Zooms as an agent asked.
    pub fn zoom_to(&mut self, to: ZoomTo, window: &mut Window, cx: &mut Context<Self>) {
        match to {
            ZoomTo::Fit => self.zoom_to_fit(&ZoomToFit, window, cx),
            ZoomTo::ActualSize => self.actual_size(&ActualSize, window, cx),
            ZoomTo::In => self.zoom_in(&ZoomIn, window, cx),
            ZoomTo::Out => self.zoom_out(&ZoomOut, window, cx),
            ZoomTo::Percent(percent) => {
                let scale = percent / 100. / window.scale_factor();
                self.zoom_centered(|_| scale, cx);
            }
        }
    }

    pub fn show_sidebar(&mut self, show: bool, cx: &mut Context<Self>) {
        self.sidebar = show;
        cx.notify();
    }

    pub fn show_export_panel(&mut self, show: bool, cx: &mut Context<Self>) {
        self.export_panel = show;
        cx.notify();
    }

    /// How the window shows its document, for agents.
    pub fn report(&self) -> serde_json::Value {
        let zoom = self.zoom.scale.map_or_else(
            || "fit".to_string(),
            |scale| format!("{:.0}%", scale * self.screen_scale * 100.),
        );
        serde_json::json!({
            "zoom": zoom,
            "sidebar": self.sidebar,
            "export_panel": self.export_panel,
        })
    }

    fn show_in_finder(&mut self, _: &ShowInFinder, _: &mut Window, cx: &mut Context<Self>) {
        let document = self.document.read(cx);
        let path = document
            .current()
            .map_or_else(|| document.folder().to_path_buf(), PathBuf::from);
        cx.reveal_path(&path);
    }

    fn choose_all(&mut self, _: &ChooseAll, _: &mut Window, cx: &mut Context<Self>) {
        self.document.update(cx, |document, cx| {
            document.choose_all();
            cx.notify();
        });
    }

    fn toggle_chosen(&mut self, action: &ToggleChosen, _: &mut Window, cx: &mut Context<Self>) {
        self.document.update(cx, |document, cx| {
            if let Some(path) = document.find(&action.name).cloned() {
                document.toggle_chosen(&path);
                cx.notify();
            }
        });
    }

    fn choose_through(&mut self, action: &ChooseThrough, _: &mut Window, cx: &mut Context<Self>) {
        self.document.update(cx, |document, cx| {
            if let Some(path) = document.find(&action.name).cloned() {
                document.choose_through(&path);
                cx.notify();
            }
        });
    }

    fn set_export_format(
        &mut self,
        action: &SetExportFormat,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.document.update(cx, |document, cx| {
            document.export.format = action.format;
            cx.notify();
        });
    }

    fn set_export_quality(
        &mut self,
        action: &SetExportQuality,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.document.update(cx, |document, cx| {
            document.export.quality = action.quality.clamp(1, 100);
            cx.notify();
        });
    }

    fn set_export_size(&mut self, action: &SetExportSize, _: &mut Window, cx: &mut Context<Self>) {
        let (width, height) = self.document.read(cx).shown_size().unwrap_or((1, 1));
        let understood = crate::size::understand(action.size.clone(), width, height, cx);
        let document = self.document.clone();
        cx.spawn(async move |_, cx| {
            let size = understood.await;
            document.update(cx, |document, cx| {
                match size {
                    Ok(size) => document.export.size = size,
                    Err(problem) => document.problem = Some(problem),
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn edit_size(&mut self, _: &EditSize, window: &mut Window, cx: &mut Context<Self>) {
        if self.document.read(cx).loaded().is_some() {
            let current = self.document.read(cx).edits().size;
            self.start_editing_size(current, false, window, cx);
        }
    }

    fn edit_export_size(
        &mut self,
        _: &EditExportSize,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.export_panel = true;
        let current = self.document.read(cx).export.size;
        self.start_editing_size(current, true, window, cx);
    }

    /// Replaces a size with a text field holding it, all selected. Enter or clicking away saves;
    /// Escape cancels. A size that can't be read beeps and keeps the field open, or is dropped
    /// if the field has already lost focus.
    fn start_editing_size(
        &mut self,
        current: Size,
        export: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let input = cx.new(|cx| TextField::new(current.as_input(), window, cx));
        let events = cx.subscribe_in(&input, window, move |this, input, event, window, cx| {
            let text = input.read(cx).text().to_string();
            if let TextFieldEvent::Confirm = event {
                // Text the model already read is sent as the size it found, so it isn't read
                // twice. Anything still unread goes as typed, and is read when it arrives.
                let known = this.size_editor.as_ref().and_then(|editor| editor.size(cx));
                let text = match known {
                    Some(Ok(size)) => size.as_input(),
                    _ => text,
                };
                if !text.trim().is_empty() {
                    let action = if export {
                        SetExportSize { size: text }.boxed_clone()
                    } else {
                        Resize {
                            document: Some(this.id(cx)),
                            size: text,
                        }
                        .boxed_clone()
                    };
                    window.dispatch_action(action, cx);
                }
            }
            // Cancelling moves focus away, which also confirms, so only the first event counts.
            if this.size_editor.take().is_some() {
                window.focus(&this.focus_handle, cx);
                cx.notify();
            }
        });
        self.size_editor = Some(SizeEditor {
            _changes: cx.observe(&input, |this, _, cx| {
                this.read_typed_size(cx);
                cx.notify();
            }),
            input,
            export,
            understood: None,
            reading: None,
            _events: events,
        });
        cx.notify();
    }

    /// Once typing pauses on a size the parser can't read, asks the decision model what it
    /// means, so the preview can show it before Enter.
    fn read_typed_size(&mut self, cx: &mut Context<Self>) {
        let shown = self.document.read(cx).shown_size();
        let Some(editor) = &mut self.size_editor else {
            return;
        };
        let text = editor.input.read(cx).text().trim().to_string();
        editor.reading = None;
        if text.is_empty() || editor.size(cx).is_some() {
            return;
        }
        let Some((width, height)) = shown else {
            return;
        };
        editor.reading = Some(cx.spawn(async move |this, cx| {
            cx.background_executor()
                .timer(Duration::from_millis(350))
                .await;
            let Ok(understanding) = this.update(cx, |_, cx| {
                crate::size::understand(text.clone(), width, height, cx)
            }) else {
                return;
            };
            let understood = understanding.await;
            this.update(cx, |this, cx| {
                if let Some(editor) = &mut this.size_editor {
                    editor.understood = Some((text, understood));
                    editor.reading = None;
                    cx.notify();
                }
            })
            .ok();
        }));
    }

    /// ⌘W, the same as the window's close button.
    fn close(&mut self, _: &kit::CloseWindow, window: &mut Window, cx: &mut Context<Self>) {
        if should_close(&self.document, window, cx) {
            let document = Some(self.id(cx));
            window.dispatch_action(
                Close {
                    document,
                    save: Some(false),
                }
                .boxed_clone(),
                cx,
            );
        }
    }

    fn render_sidebar(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme();
        let document = self.document.read(cx);
        let count = document.files().len();
        let summary = match (count, document.chosen().len()) {
            (1, _) => "1 image".to_string(),
            (count, 0) => format!("{count} images"),
            (count, chosen) => format!("{} of {count} chosen", chosen + 1),
        };
        div()
            .w(px(240.))
            .flex_none()
            .flex()
            .flex_col()
            .border_r_1()
            .border_color(theme.border)
            .child(kit::titlebar())
            .child(
                div()
                    .px(px(12.))
                    .pt(px(4.))
                    .pb(px(8.))
                    .flex()
                    .flex_col()
                    .gap(px(2.))
                    .child(div().truncate().child(document.folder_name()))
                    .child(
                        div()
                            .text_size(text::SMALL)
                            .text_color(theme.text_muted)
                            .child(summary),
                    ),
            )
            .child(
                div()
                    .flex_1()
                    .min_h(px(0.))
                    .relative()
                    .child(
                        uniform_list(
                            "images",
                            count,
                            cx.processor(|this, range: Range<usize>, _, cx| {
                                let files = this.document.read(cx).files()[range].to_vec();
                                files
                                    .into_iter()
                                    .map(|path| this.render_row(path, cx))
                                    .collect()
                            }),
                        )
                        .track_scroll(&self.list)
                        .size_full()
                        .px(px(6.)),
                    )
                    .child(kit::scrollbar("images-scrollbar", &self.list)),
            )
            .child(
                div().flex().p(px(8.)).child(
                    Button::new("open", "Open Folder…", OpenDialog)
                        .icon(Icon::Folder)
                        .grow(),
                ),
            )
    }

    fn render_row(&self, path: PathBuf, cx: &mut Context<Self>) -> AnyElement {
        let theme = *cx.theme();
        let document = self.document.read(cx);
        let id = document.id();
        let current = document.current() == Some(path.as_path());
        let chosen = !current && document.is_chosen(&path);
        let mark = if document.is_saving(&path) {
            "Saving"
        } else if document.is_edited(&path) {
            "Edited"
        } else {
            ""
        };
        let thumbnail = self
            .thumbnails
            .update(cx, |thumbnails, cx| thumbnails.get(&path, cx));
        let picture = match thumbnail {
            Some(thumbnail) => img(thumbnail)
                .size(px(28.))
                .flex_none()
                .rounded(px(4.))
                .object_fit(gpui::ObjectFit::Cover)
                .into_any_element(),
            None => div()
                .size(px(28.))
                .flex_none()
                .flex()
                .items_center()
                .justify_center()
                .child(icon(Icon::Image).text_color(theme.text_faint))
                .into_any_element(),
        };
        let name = file_name(&path);
        div()
            .id(SharedString::from(path.to_string_lossy().into_owned()))
            .w_full()
            .h(px(36.))
            .px(px(6.))
            .flex()
            .items_center()
            .gap(px(8.))
            .rounded(px(6.))
            .cursor_pointer()
            .map(|this| {
                if current {
                    this.bg(theme.selection)
                } else if chosen {
                    this.bg(theme.surface)
                } else {
                    this.hover(|style| style.bg(theme.surface))
                }
            })
            .on_click({
                let name = name.clone();
                move |event: &ClickEvent, window, cx| {
                    let modifiers = event.modifiers();
                    let action = if modifiers.platform {
                        ToggleChosen { name: name.clone() }.boxed_clone()
                    } else if modifiers.shift {
                        ChooseThrough { name: name.clone() }.boxed_clone()
                    } else {
                        ShowImage {
                            document: Some(id),
                            name: name.clone(),
                        }
                        .boxed_clone()
                    };
                    window.dispatch_action(action, cx);
                }
            })
            .child(picture)
            .child(div().flex_1().min_w(px(0.)).truncate().child(name))
            .child(
                div()
                    .flex_none()
                    .text_size(text::SMALL)
                    .text_color(theme.text_muted)
                    .child(mark),
            )
            .into_any_element()
    }

    fn render_toolbar(&self, cx: &Context<Self>) -> impl IntoElement {
        let theme = cx.theme();
        let document = self.document.read(cx);
        let ready = document.loaded().is_some();
        let cropping = self.crop_editor.is_some();
        let zoom = self.placement.get().map_or_else(String::new, |placement| {
            format!("{:.0}%", placement.scale * 100.)
        });
        let rotate = |direction| Rotate {
            document: None,
            direction,
        };
        let flip = |direction| Flip {
            document: None,
            direction,
        };
        let resizing = self
            .size_editor
            .as_ref()
            .is_some_and(|editor| !editor.export);
        div()
            .h(px(40.))
            .flex_none()
            .px(px(10.))
            .flex()
            .items_center()
            .gap(px(8.))
            .border_b_1()
            .border_color(theme.border)
            .child(
                Grid::new("sidebar").cell(
                    GridCell::icon(Icon::Sidebar, "Show or Hide Images", ToggleSidebar)
                        .on(self.sidebar),
                ),
            )
            .child(
                Grid::new("zoom").cells([
                    GridCell::icon(Icon::ZoomOut, "Zoom Out", ZoomOut).disabled(!ready),
                    GridCell::icon(Icon::ZoomIn, "Zoom In", ZoomIn).disabled(!ready),
                    GridCell::icon(Icon::Fit, "Zoom to Fit", ZoomToFit)
                        .disabled(!ready)
                        .on(self.zoom == Zoom::default() && ready),
                ]),
            )
            .child(
                div()
                    .w(px(44.))
                    .flex_none()
                    .text_size(text::SMALL)
                    .text_color(theme.text_muted)
                    .tabular_nums()
                    .child(if ready { zoom } else { String::new() }),
            )
            .child(div().flex_1())
            .child(Grid::new("history").cells([
                GridCell::icon(Icon::Undo, "Undo", Undo::default()).disabled(!document.can_undo()),
                GridCell::icon(Icon::Redo, "Redo", Redo::default()).disabled(!document.can_redo()),
            ]))
            .child(
                Grid::new("turn").cells([
                    GridCell::icon(Icon::RotateLeft, "Rotate Left", rotate(Turn::Left))
                        .disabled(!ready || cropping),
                    GridCell::icon(Icon::RotateRight, "Rotate Right", rotate(Turn::Right))
                        .disabled(!ready || cropping),
                    GridCell::icon(
                        Icon::FlipHorizontal,
                        "Flip Horizontal",
                        flip(FlipDirection::Horizontal),
                    )
                    .disabled(!ready || cropping),
                    GridCell::icon(
                        Icon::FlipVertical,
                        "Flip Vertical",
                        flip(FlipDirection::Vertical),
                    )
                    .disabled(!ready || cropping),
                ]),
            )
            .child(
                Grid::new("edit").cells([
                    GridCell::icon(Icon::Markup, "Markup", ToggleMarkup)
                        .disabled(!ready)
                        .on(self.markup),
                    GridCell::icon(Icon::Crop, "Crop", ToggleCrop)
                        .disabled(!ready)
                        .on(cropping),
                    GridCell::icon(Icon::Resize, "Resize", EditSize)
                        .disabled(!ready || cropping)
                        .on(resizing),
                ]),
            )
            .child(Grid::new("output").cells([
                GridCell::icon(Icon::Copy, "Copy", Copy::default()).disabled(!ready),
                GridCell::icon(Icon::Export, "Export", ToggleExport).on(self.export_panel),
            ]))
    }

    fn render_picture(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = *cx.theme();
        let document = self.document.read(cx);
        let message = |text: String| {
            div()
                .flex_1()
                .min_h(px(0.))
                .flex()
                .flex_col()
                .items_center()
                .justify_center()
                .gap(px(10.))
                .text_color(theme.text_muted)
                .child(icon(Icon::Image).size(px(48.)).text_color(theme.text_faint))
                .child(text)
                .into_any_element()
        };
        let loaded = match document.picture() {
            Shown::Empty => return message("No images in this folder".into()),
            Shown::Loading => return message("Reading…".into()),
            Shown::Unreadable(error) => return message(error.clone()),
            Shown::Ready(loaded) => loaded.clone(),
        };
        let Some(textures) = self
            .textures
            .as_ref()
            .filter(|textures| textures.path == loaded.path)
        else {
            return div().flex_1().into_any_element();
        };
        let edits = document.edits();
        let (width, height) = (textures.width, textures.height);
        let dragged = self
            .crop_editor
            .as_ref()
            .and_then(|editor| editor.drag)
            .map(|drag| drag.rect);
        let previewed = self.crop_preview(cx).and_then(Result::ok);
        let crop = previewed
            .or(dragged)
            .or(edits.crop.map(|crop| crop.rect))
            .unwrap_or(Rect::whole(width, height));
        let editing = self.crop_editor.as_ref().map(|editor| Editing {
            handle: editor.handle,
            dragging: editor.drag.map(|drag| drag.handle),
        });
        let (marks, live, selection) = self.marks_for_picture(cx);
        Picture {
            small: textures.small.clone(),
            full: textures.full.clone(),
            image: (width, height),
            crop,
            editing,
            zoom: self.zoom,
            panning: self.panning.is_some(),
            theme,
            view: cx.entity().downgrade(),
            placement: self.placement.clone(),
            enlarged: self.enlarged.clone(),
            marks,
            live,
            selection,
            tool: if self.crop_editor.is_some() {
                Tool::Select
            } else {
                self.tool
            },
            overlays: self.overlays.clone(),
        }
        .render()
        .into_any_element()
    }

    /// The line under the picture: what the image is and what the edits make of it, or while
    /// cropping, the crop's shape and the buttons to finish.
    fn render_details(&self, window: &Window, cx: &Context<Self>) -> impl IntoElement {
        let theme = cx.theme();
        let document = self.document.read(cx);
        let bar = div()
            .h(px(44.))
            .flex_none()
            .px(px(12.))
            .flex()
            .items_center()
            .gap(px(12.))
            .border_t_1()
            .border_color(theme.border)
            .text_size(text::SMALL)
            .text_color(theme.text_muted)
            .tabular_nums();
        if let Some((crop, (width, height))) = self.crop_target(cx) {
            let dragged = self
                .crop_editor
                .as_ref()
                .and_then(|editor| editor.drag)
                .map_or(crop.rect, |drag| drag.rect);
            let aspect_choice = ASPECTS
                .iter()
                .position(|&(_, input)| Aspect::parse(input) == Ok(crop.aspect));
            let shape = Grid::new("aspect")
                .grow()
                .cells(ASPECTS.iter().enumerate().map(|(index, &(label, input))| {
                    GridCell::text(label, SetCrop::aspect(input)).on(aspect_choice == Some(index))
                }));
            let cropped = dragged != Rect::whole(width, height);
            return bar
                .child(div().w(px(380.)).flex_none().flex().child(shape))
                .child(self.render_crop_words(dragged, window, cx))
                .child(Button::new("clear-crop", "Clear", ClearCrop::default()).disabled(!cropped))
                .child(Button::new("cancel-crop", "Cancel", CancelCrop))
                .child(
                    Button::new("apply-crop", "Done", ApplyCrop)
                        .icon(Icon::Check)
                        .variant(ButtonVariant::Primary),
                );
        }
        if let Some(editor) = &self.text_editor {
            return bar
                .child(div().text_color(theme.text).child("Text"))
                .child(div().w(px(360.)).child(editor.input.clone()));
        }
        let Some(loaded) = document.loaded() else {
            return bar;
        };
        let edits = document.edits();
        let Info { width, height, .. } = loaded.info;
        let (cropped_width, cropped_height) = edits.cropped_size(width, height);
        let result = match &self.size_editor {
            Some(editor) if !editor.export => {
                let note = match editor.size(cx) {
                    Some(Ok(size)) => {
                        let (to_width, to_height) = size.apply(cropped_width, cropped_height);
                        format!("{to_width} × {to_height}")
                    }
                    Some(Err(problem)) => problem,
                    None if editor.reading.is_some() => "…".into(),
                    None => String::new(),
                };
                div()
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .child(div().w(px(160.)).child(editor.input.clone()))
                    .child(note)
                    .into_any_element()
            }
            _ => {
                let (to_width, to_height) = edits.output_size(width, height);
                let changed = !edits.is_unchanged();
                div()
                    .id("result-size")
                    .relative()
                    .px(px(6.))
                    .py(px(2.))
                    .rounded(px(4.))
                    .cursor_pointer()
                    .hover(|style| style.bg(theme.surface))
                    .when(changed, |this| this.text_color(theme.text))
                    .on_click(|_, window, cx| window.dispatch_action(EditSize.boxed_clone(), cx))
                    .child(if changed {
                        format!("→ {to_width} × {to_height}")
                    } else {
                        "Resize…".to_string()
                    })
                    .children(kit::reveal_shortcut(&EditSize, window, cx))
                    .into_any_element()
            }
        };
        bar.child(
            div()
                .flex_1()
                .min_w(px(0.))
                .truncate()
                .child(describe(&loaded.info)),
        )
        .when_some(document.problem.clone(), |this, problem| {
            this.child(div().text_color(theme.text).truncate().child(problem))
        })
        .child(result)
    }

    fn render_export_panel(&self, window: &Window, cx: &Context<Self>) -> impl IntoElement {
        let theme = cx.theme();
        let document = self.document.read(cx);
        let settings = document.export;
        let targets = document.export_targets();
        let formats = Grid::new("formats")
            .grow()
            .cells(ExportFormat::ALL.map(|format| {
                GridCell::text(format.label(), SetExportFormat { format })
                    .on(format == settings.format)
            }));
        let lossy = !matches!(settings.format, ExportFormat::Png);
        let quality_choice = QUALITIES
            .iter()
            .position(|&(_, quality)| quality == settings.quality);
        let size_field = match &self.size_editor {
            Some(editor) if editor.export => div().child(editor.input.clone()).into_any_element(),
            _ => div()
                .id("export-size")
                .relative()
                .h(px(25.))
                .px(px(6.))
                .flex()
                .items_center()
                .rounded(px(4.))
                .border_1()
                .border_color(theme.border)
                .cursor_pointer()
                .hover(|style| style.bg(theme.surface))
                .on_click(|_, window, cx| window.dispatch_action(EditExportSize.boxed_clone(), cx))
                .child(div().truncate().child(settings.size.describe()))
                .children(kit::reveal_shortcut(&EditExportSize, window, cx))
                .into_any_element(),
        };
        let label = |text: &'static str| div().text_color(theme.text_muted).child(text);
        let results = document.exported.iter().map(|(path, result)| {
            let line = match result {
                Ok(exported) => format!(
                    "{} · {} × {} · {}",
                    file_name(&exported.path),
                    exported.width,
                    exported.height,
                    format_bytes(exported.bytes)
                ),
                Err(error) => format!("{}: {error}", file_name(path)),
            };
            div().truncate().child(line)
        });
        let export_label = match targets.len() {
            0 | 1 => "Export".to_string(),
            count => format!("Export {count}"),
        };
        div()
            .w(px(320.))
            .flex_none()
            .flex()
            .flex_col()
            .gap(px(10.))
            .p(px(12.))
            .border_l_1()
            .border_color(theme.border)
            .child(label("Format"))
            .child(div().flex().child(formats))
            .child(label("Quality"))
            .child(
                div().flex().child(
                    Grid::new("quality")
                        .grow()
                        .cells(
                            QUALITIES
                                .iter()
                                .enumerate()
                                .map(|(index, &(label, quality))| {
                                    GridCell::text(label, SetExportQuality { quality })
                                        .on(quality_choice == Some(index))
                                        .disabled(!lossy)
                                }),
                        ),
                ),
            )
            .child(label("Size"))
            .child(size_field)
            .child(
                div().flex().pt(px(4.)).child(
                    Button::new("export-now", export_label, Export::default())
                        .icon(Icon::Export)
                        .variant(ButtonVariant::Primary)
                        .disabled(targets.is_empty())
                        .grow(),
                ),
            )
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(4.))
                    .text_size(text::SMALL)
                    .tabular_nums()
                    .children(results),
            )
    }
}

/// Whether a document's window can close now. With unsaved edits it asks first, and closes
/// later if the answer allows.
fn should_close(document: &Entity<Document>, window: &mut Window, cx: &mut App) -> bool {
    let document = document.read(cx);
    let unsaved = document.unsaved();
    if unsaved.is_empty() {
        return true;
    }
    let id = Some(document.id());
    let message = match unsaved.as_slice() {
        [only] => format!("Save your changes to {}?", file_name(only)),
        many => format!("Save your changes to {} images?", many.len()),
    };
    let answer = window.prompt(
        PromptLevel::Warning,
        &message,
        Some("Your changes are lost if you don't save them."),
        &["Save", "Don't Save", "Cancel"],
        cx,
    );
    cx.spawn(async move |cx| {
        let save = match answer.await {
            Ok(0) => true,
            Ok(1) => false,
            _ => return,
        };
        cx.update(|cx| {
            cx.dispatch_action(&Close {
                document: id,
                save: Some(save),
            })
        });
    })
    .detach();
    false
}

/// "4032 × 3024 · HEIC · 2.4 MB", noting location and camera details, which exports drop.
fn describe(info: &Info) -> String {
    let private = match (info.location, info.camera) {
        (true, true) => " · Has its location and camera",
        (true, false) => " · Has its location",
        (false, true) => " · Has its camera",
        (false, false) => "",
    };
    format!(
        "{} × {} · {} · {}{private}",
        info.width,
        info.height,
        info.kind,
        format_bytes(info.bytes)
    )
}

/// Sizes the way Finder shows them, in powers of 1,000: "812 bytes", "310 KB", "2.4 MB".
pub fn format_bytes(bytes: u64) -> String {
    match bytes {
        bytes if bytes < 1_000 => format!("{bytes} bytes"),
        bytes if bytes < 1_000_000 => format!("{:.0} KB", bytes as f64 / 1e3),
        bytes if bytes < 1_000_000_000 => format!("{:.1} MB", bytes as f64 / 1e6),
        bytes => format!("{:.1} GB", bytes as f64 / 1e9),
    }
}

impl Focusable for DocumentWindow {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

impl Render for DocumentWindow {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.screen_scale = window.scale_factor();
        let theme = cx.theme();
        let name: SharedString = self
            .document
            .read(cx)
            .current()
            .map(file_name)
            .unwrap_or_default()
            .into();
        let detail = div()
            .flex_1()
            .min_w(px(0.))
            .flex()
            .flex_col()
            .child(
                kit::titlebar()
                    .justify_center()
                    .text_color(theme.text_muted)
                    .child(name),
            )
            .child(self.render_toolbar(cx))
            .when(self.markup, |this| this.child(self.render_markup_bar(cx)))
            .child(
                div()
                    .flex_1()
                    .min_h(px(0.))
                    .flex()
                    .child(
                        div()
                            .flex_1()
                            .min_w(px(0.))
                            .flex()
                            .flex_col()
                            .child(self.render_picture(cx))
                            .child(self.render_details(window, cx)),
                    )
                    .when(self.export_panel, |this| {
                        this.child(self.render_export_panel(window, cx))
                    }),
            );
        kit::root(cx)
            .flex_row()
            .track_focus(&self.focus_handle)
            .key_context("Images")
            .on_action(cx.listener(Self::close))
            .on_action(cx.listener(Self::toggle_sidebar))
            .on_action(cx.listener(Self::toggle_export))
            .on_action(cx.listener(Self::zoom_in))
            .on_action(cx.listener(Self::zoom_out))
            .on_action(cx.listener(Self::zoom_to_fit))
            .on_action(cx.listener(Self::actual_size))
            .on_action(cx.listener(Self::edit_size))
            .on_action(cx.listener(Self::edit_export_size))
            .on_action(cx.listener(Self::show_in_finder))
            .on_action(cx.listener(Self::choose_all))
            .on_action(cx.listener(Self::toggle_chosen))
            .on_action(cx.listener(Self::choose_through))
            .on_action(cx.listener(Self::set_export_format))
            .on_action(cx.listener(Self::set_export_quality))
            .on_action(cx.listener(Self::set_export_size))
            .on_action(cx.listener(Self::toggle_crop))
            .on_action(cx.listener(Self::describe_crop))
            .on_action(cx.listener(Self::toggle_markup))
            .on_action(cx.listener(Self::choose_tool))
            .on_action(cx.listener(Self::set_mark_color))
            .on_action(cx.listener(Self::set_thickness))
            // Only with a mark chosen, so their keys fall through otherwise.
            .when(self.selected.is_some(), |this| {
                this.on_action(cx.listener(Self::delete_selected_mark))
                    .on_action(cx.listener(Self::nudge_mark))
                    .on_action(cx.listener(Self::edit_mark_text))
            })
            .when(
                self.selected.is_some() || self.tool != Tool::Select,
                |this| this.on_action(cx.listener(Self::deselect_mark)),
            )
            // Only while cropping, so their keys fall through to other bindings otherwise (see
            // `key_bindings`), and their menu items are disabled.
            .when(self.crop_editor.is_some(), |this| {
                this.on_action(cx.listener(Self::apply_crop))
                    .on_action(cx.listener(Self::cancel_crop))
                    .on_action(cx.listener(Self::next_crop_handle))
                    .on_action(cx.listener(Self::previous_crop_handle))
                    .on_action(cx.listener(Self::nudge_crop))
            })
            .when(self.sidebar, |this| this.child(self.render_sidebar(cx)))
            .child(detail)
    }
}
