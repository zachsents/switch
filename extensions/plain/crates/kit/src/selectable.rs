//! Text that can be selected and copied, like a page's: drag across it, double-click a word,
//! triple-click it all, and ⌘C copies what's selected. Ranges of it can be clickable (a link
//! opens, code copies) when a press doesn't become a drag. A window has one selection: starting
//! one clears the last, and clicking anywhere else clears it too.
//!
//! Copying works through the window's [`root`](crate::root), which takes ⌘C when no text field
//! has something selected of its own.

use std::{cell::RefCell, ops::Range, rc::Rc};

use gpui::{
    App, Bounds, ClipboardItem, CursorStyle, DispatchPhase, Element, ElementId, Global,
    GlobalElementId, Hitbox, HitboxBehavior, InspectorElementId, IntoElement, LayoutId,
    MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent, Pixels, Point, SharedString,
    StyledText, TextRun, Window, WindowId, fill, point, px, size,
};
use unicode_segmentation::UnicodeSegmentation;

use crate::ActiveTheme;

type ClickHandler = Rc<dyn Fn(&mut Window, &mut App)>;

/// Selectable text, with styled runs and clickable ranges.
pub struct SelectableText {
    id: ElementId,
    text: StyledText,
    content: SharedString,
    clickable: Vec<(Range<usize>, ClickHandler)>,
}

impl SelectableText {
    pub fn new(id: impl Into<ElementId>, text: impl Into<SharedString>) -> Self {
        let content = text.into();
        Self {
            id: id.into(),
            text: StyledText::new(content.clone()),
            content,
            clickable: Vec::new(),
        }
    }

    /// Styles it in runs, as [`StyledText::with_runs`] does.
    pub fn with_runs(mut self, runs: Vec<TextRun>) -> Self {
        self.text = StyledText::new(self.content.clone()).with_runs(runs);
        self
    }

    /// Runs `handler` when `range` is clicked without dragging, like a link.
    pub fn on_click_range(
        mut self,
        range: Range<usize>,
        handler: impl Fn(&mut Window, &mut App) + 'static,
    ) -> Self {
        self.clickable.push((range, Rc::new(handler)));
        self
    }
}

/// The window's selection: whose it is and what it says.
#[derive(Default)]
struct PageSelection {
    window: Option<WindowId>,
    owner: Option<GlobalElementId>,
    text: String,
}

impl Global for PageSelection {}

/// Copies the window's selection, if it has one. The root calls it for ⌘C.
pub(crate) fn copy_selection(window: &Window, cx: &mut App) -> bool {
    let id = window.window_handle().window_id();
    match cx.try_global::<PageSelection>() {
        Some(selection) if selection.window == Some(id) && !selection.text.is_empty() => {
            cx.write_to_clipboard(ClipboardItem::new_string(selection.text.clone()));
            true
        }
        _ => false,
    }
}

/// What a drag selects by: whatever the click that started it selected.
#[derive(Clone, Copy, Default, PartialEq)]
enum Unit {
    #[default]
    Character,
    Word,
    All,
}

#[derive(Default)]
struct State {
    selection: Option<Range<usize>>,
    anchor: Range<usize>,
    unit: Unit,
    dragging: bool,
    /// Where the press that's down started, until it moves.
    pressed_at: Option<usize>,
    moved: bool,
}

impl State {
    fn extend(&mut self, under: Range<usize>) {
        let (start, end) = if under.start < self.anchor.start {
            (under.start, self.anchor.end)
        } else {
            (self.anchor.start, under.end.max(self.anchor.end))
        };
        self.selection = (start < end).then_some(start..end);
    }
}

fn word_at(text: &str, index: usize) -> Range<usize> {
    let segments: Vec<Range<usize>> = text
        .split_word_bound_indices()
        .map(|(start, segment)| start..start + segment.len())
        .collect();
    let is_word = |range: &Range<usize>| text[range.clone()].chars().any(char::is_alphanumeric);
    let after = segments.iter().find(|range| range.contains(&index));
    let before = segments.iter().find(|range| range.end == index);
    match (before, after) {
        (Some(before), Some(after)) if is_word(before) && !is_word(after) => before.clone(),
        (_, Some(after)) => after.clone(),
        (Some(before), None) => before.clone(),
        (None, None) => index..index,
    }
}

impl IntoElement for SelectableText {
    type Element = Self;

    fn into_element(self) -> Self::Element {
        self
    }
}

impl Element for SelectableText {
    type RequestLayoutState = ();
    type PrepaintState = Hitbox;

    fn id(&self) -> Option<ElementId> {
        Some(self.id.clone())
    }

    fn source_location(&self) -> Option<&'static core::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        _: Option<&GlobalElementId>,
        inspector_id: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, ()) {
        self.text.request_layout(None, inspector_id, window, cx)
    }

    fn prepaint(
        &mut self,
        _: Option<&GlobalElementId>,
        inspector_id: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        state: &mut (),
        window: &mut Window,
        cx: &mut App,
    ) -> Hitbox {
        self.text
            .prepaint(None, inspector_id, bounds, state, window, cx);
        window.insert_hitbox(bounds, HitboxBehavior::Normal)
    }

    fn paint(
        &mut self,
        global_id: Option<&GlobalElementId>,
        inspector_id: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        layout_state: &mut (),
        hitbox: &mut Hitbox,
        window: &mut Window,
        cx: &mut App,
    ) {
        let Some(global_id) = global_id.cloned() else {
            self.text.paint(
                None,
                inspector_id,
                bounds,
                layout_state,
                &mut (),
                window,
                cx,
            );
            return;
        };
        let layout = self.text.layout().clone();
        let content = self.content.clone();
        let window_id = window.window_handle().window_id();
        let state = window.with_element_state::<Rc<RefCell<State>>, _>(&global_id, |state, _| {
            let state = state.unwrap_or_default();
            (state.clone(), state)
        });
        // Another selection took over: this one is gone.
        let owned = cx.try_global::<PageSelection>().is_some_and(|selection| {
            selection.window == Some(window_id) && selection.owner.as_ref() == Some(&global_id)
        });
        if !owned {
            let mut state = state.borrow_mut();
            state.selection = None;
            state.dragging = false;
        }

        // The selection, under the text.
        if let Some(range) = state.borrow().selection.clone() {
            let line_height = layout.line_height();
            if let (Some(start), Some(end)) = (
                layout.position_for_index(range.start),
                layout.position_for_index(range.end),
            ) {
                let color = cx.theme().selection;
                let mut y = start.y;
                while y <= end.y + px(0.5) {
                    let from = if (y - start.y).abs() < px(0.5) {
                        start.x
                    } else {
                        bounds.left()
                    };
                    let to = if (y - end.y).abs() < px(0.5) {
                        end.x
                    } else {
                        bounds.right()
                    };
                    if to > from {
                        window.paint_quad(fill(
                            Bounds::new(point(from, y), size(to - from, line_height)),
                            color,
                        ));
                    }
                    y += line_height;
                }
            }
        }
        self.text.paint(
            None,
            inspector_id,
            bounds,
            layout_state,
            &mut (),
            window,
            cx,
        );

        let over_link = self.clickable.iter().any(|(range, _)| {
            layout
                .index_for_position(window.mouse_position())
                .is_ok_and(|index| range.contains(&index))
        });
        window.set_cursor_style(
            if over_link {
                CursorStyle::PointingHand
            } else {
                CursorStyle::IBeam
            },
            hitbox,
        );

        let index_at = {
            let layout = layout.clone();
            move |position: Point<Pixels>| {
                layout
                    .index_for_position(position)
                    .unwrap_or_else(|closest| closest)
            }
        };
        let selected_text = {
            let content = content.clone();
            move |range: &Range<usize>| content.get(range.clone()).unwrap_or_default().to_string()
        };
        let publish = {
            let global_id = global_id.clone();
            move |state: &State, cx: &mut App| {
                let selection = cx.default_global::<PageSelection>();
                selection.window = Some(window_id);
                selection.owner = Some(global_id.clone());
                selection.text = state
                    .selection
                    .as_ref()
                    .map(&selected_text)
                    .unwrap_or_default();
            }
        };

        window.on_mouse_event({
            let (hitbox, state, index_at, publish, content) = (
                hitbox.clone(),
                state.clone(),
                index_at.clone(),
                publish.clone(),
                content.clone(),
            );
            let global_id = global_id.clone();
            move |event: &MouseDownEvent, phase, window, cx| {
                if phase != DispatchPhase::Bubble || event.button != MouseButton::Left {
                    return;
                }
                if !hitbox.is_hovered(window) {
                    // A press anywhere else lets go of this selection.
                    let selection = cx.default_global::<PageSelection>();
                    if selection.owner.as_ref() == Some(&global_id) {
                        selection.owner = None;
                        selection.text.clear();
                        state.borrow_mut().selection = None;
                        window.refresh();
                    }
                    return;
                }
                let index = index_at(event.position);
                let mut state = state.borrow_mut();
                state.dragging = true;
                state.moved = false;
                state.pressed_at = Some(index);
                match event.click_count {
                    0 | 1 => {
                        state.unit = Unit::Character;
                        if event.modifiers.shift
                            && let Some(selection) = state.selection.clone()
                        {
                            state.anchor = selection.start..selection.start;
                            state.extend(index..index);
                        } else {
                            state.anchor = index..index;
                            state.selection = None;
                        }
                    }
                    2 => {
                        state.unit = Unit::Word;
                        state.anchor = word_at(&content, index);
                        state.selection = Some(state.anchor.clone());
                    }
                    _ => {
                        state.unit = Unit::All;
                        state.anchor = 0..content.len();
                        state.selection = Some(state.anchor.clone());
                    }
                }
                publish(&state, cx);
                window.refresh();
            }
        });

        window.on_mouse_event({
            let (state, index_at, publish, content) = (
                state.clone(),
                index_at.clone(),
                publish.clone(),
                content.clone(),
            );
            move |event: &MouseMoveEvent, phase, window, cx| {
                if phase != DispatchPhase::Bubble || event.pressed_button != Some(MouseButton::Left)
                {
                    return;
                }
                let mut state = state.borrow_mut();
                if !state.dragging {
                    return;
                }
                let index = index_at(event.position);
                if state.pressed_at != Some(index) {
                    state.moved = true;
                }
                let under = match state.unit {
                    Unit::Character => index..index,
                    Unit::Word => word_at(&content, index),
                    Unit::All => 0..content.len(),
                };
                state.extend(under);
                publish(&state, cx);
                window.refresh();
            }
        });

        window.on_mouse_event({
            let (hitbox, state, index_at) = (hitbox.clone(), state.clone(), index_at.clone());
            let clickable = std::mem::take(&mut self.clickable);
            move |event: &MouseUpEvent, phase, window, cx| {
                if phase != DispatchPhase::Bubble || event.button != MouseButton::Left {
                    return;
                }
                let (clicked, unit) = {
                    let mut state = state.borrow_mut();
                    if !state.dragging {
                        return;
                    }
                    state.dragging = false;
                    (!state.moved && hitbox.is_hovered(window), state.unit)
                };
                if clicked && unit == Unit::Character {
                    let index = index_at(event.position);
                    if let Some((_, handler)) =
                        clickable.iter().find(|(range, _)| range.contains(&index))
                    {
                        handler(window, cx);
                    }
                }
            }
        });
    }
}
