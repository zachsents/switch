//! Marking up the picture: drawing with the markup tools, choosing marks to move, restyle,
//! reword or delete, and the markup bar. Every change to a mark is an action agents can call
//! too; this only tracks what's happening under the pointer.

use gpui::{
    Action, App, AppContext, Context, Entity, IntoElement, ParentElement, Pixels, Point, Styled,
    Subscription, Window, div, px, rgba,
};
use imaging::draw::{self, Color, Mark};
use kit::{ActiveTheme, Grid, GridCell, Icon, TextField, TextFieldEvent};

use super::DocumentWindow;
use crate::{
    actions::{
        AddMark, ChooseTool, DeleteMark, DeleteSelectedMark, DeselectMark, Direction, EditMarkText,
        NudgeMark, SetMarkColor, SetThickness, ToggleMarkup, UpdateMark,
    },
    canvas::Placement,
    capitalized,
    crop::Handle,
    markup::{self, Thickness, Tool, translucent},
};

/// How near, in window points, a press must be to a mark to pick it.
const REACH: f32 = 6.;
/// How far, in window points, the pointer must move for a press to draw rather than click.
const LEAST_DRAG: f32 = 3.;

/// A mark being dragged to a new place.
pub(super) struct Moving {
    index: usize,
    /// Where it was grabbed, in the turned image's pixels.
    from: draw::Point,
    offset: (f32, f32),
}

/// A mark being drawn: the points dragged through so far, in the turned image's pixels.
pub(super) struct Drawing {
    points: Vec<draw::Point>,
    /// The least a drag must cover, in image pixels, to draw anything.
    least: f32,
}

/// A mark this window asked to add, to choose once the document has it.
pub(super) struct Adding {
    /// How many marks there were before.
    count: usize,
    /// Whether to start editing its words, for new text.
    edit_text: bool,
}

/// A text mark's words being typed, in the line under the picture.
pub(super) struct TextEditor {
    index: usize,
    pub(super) input: Entity<TextField>,
    _events: Subscription,
    _changes: Subscription,
}

impl DocumentWindow {
    /// The shown image's marks.
    fn marks(&self, cx: &App) -> Vec<Mark> {
        self.document.read(cx).edits().marks
    }

    /// The longer side of the shown image as turned, which new marks are sized from.
    fn longest(&self, cx: &App) -> u32 {
        self.document
            .read(cx)
            .loaded()
            .map_or(1000, |loaded| loaded.info.width.max(loaded.info.height))
    }

    /// Follows the document's marks: chooses a mark this window just added, and lets go of one
    /// that's gone.
    pub(super) fn marks_changed(
        &mut self,
        image_changed: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if image_changed {
            self.selected = None;
            self.text_editor = None;
            self.adding = None;
            self.drawing = None;
            self.moving = None;
        }
        let count = self.marks(cx).len();
        if let Some(adding) = self.adding.take_if(|adding| count == adding.count + 1) {
            self.selected = Some(adding.count);
            if adding.edit_text {
                self.edit_mark_text(&EditMarkText, window, cx);
            }
        }
        if self.selected.is_some_and(|index| index >= count) {
            self.selected = None;
        }
        if self
            .text_editor
            .as_ref()
            .is_some_and(|editor| Some(editor.index) != self.selected)
        {
            self.text_editor = None;
        }
    }

    /// A press on the picture: grabs a crop handle, starts drawing with the tool in use, picks a
    /// mark, or drags the picture around when it's zoomed in. A double click zooms, or edits a
    /// text mark's words.
    pub fn press(
        &mut self,
        position: Point<Pixels>,
        click_count: usize,
        handle: Option<Handle>,
        placement: Placement,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if let Some(handle) = handle {
            return self.start_drag(handle, position, placement.scale, cx);
        }
        let zoomed_in = placement.scale > placement.fit * 1.001;
        if self.crop_editor.is_some() {
            if zoomed_in {
                self.start_pan(position, placement, cx);
            }
            return;
        }
        let (x, y) = placement.image_point(position);
        let at = draw::Point { x, y };
        let marks = self.marks(cx);
        let under = markup::mark_at(&marks, at, REACH / placement.scale);
        match (self.tool, under) {
            (Tool::Select | Tool::Text, Some(index)) => {
                self.selected = Some(index);
                let is_text = matches!(marks[index], Mark::Text { .. });
                if is_text && (click_count == 2 || self.tool == Tool::Text) {
                    self.edit_mark_text(&EditMarkText, window, cx);
                } else {
                    self.text_editor = None;
                    self.moving = Some(Moving {
                        index,
                        from: at,
                        offset: (0., 0.),
                    });
                }
            }
            (Tool::Select, None) => {
                self.selected = None;
                self.text_editor = None;
                if click_count == 2 {
                    self.toggle_zoom_at(position, placement, window, cx);
                } else if zoomed_in {
                    self.start_pan(position, placement, cx);
                }
            }
            (Tool::Text, None) => {
                let mark = markup::text_at(at, &self.style, self.longest(cx));
                self.add_mark(mark, true, window, cx);
            }
            (_, _) => {
                self.selected = None;
                self.text_editor = None;
                self.drawing = Some(Drawing {
                    points: vec![at],
                    least: LEAST_DRAG / placement.scale,
                });
            }
        }
        cx.notify();
    }

    /// Follows the pointer while a mark is drawn or moved. Returns whether one is.
    pub(super) fn drag_marks(
        &mut self,
        position: Point<Pixels>,
        placement: Placement,
        cx: &mut Context<Self>,
    ) -> bool {
        let (x, y) = placement.image_point(position);
        let at = draw::Point { x, y };
        if let Some(drawing) = &mut self.drawing {
            // Shapes only need where the drag started and where it is now.
            if !matches!(self.tool, Tool::Pen | Tool::Highlight) {
                drawing.points.truncate(1);
            }
            drawing.points.push(at);
            cx.notify();
            return true;
        }
        if let Some(moving) = &mut self.moving {
            moving.offset = (at.x - moving.from.x, at.y - moving.from.y);
            cx.notify();
            return true;
        }
        false
    }

    /// Adds the mark a drag drew, or puts a moved mark where it was dropped.
    pub(super) fn finish_marks(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(drawing) = self.drawing.take() {
            let longest = self.longest(cx);
            if let Some(mark) = markup::dragged(
                self.tool,
                &drawing.points,
                &self.style,
                longest,
                drawing.least,
            ) {
                self.add_mark(mark, false, window, cx);
            }
            cx.notify();
        }
        if let Some(Moving { index, offset, .. }) = self.moving.take() {
            if offset != (0., 0.)
                && let Some(mark) = self.marks(cx).get(index)
            {
                let moved = mark.moved(offset.0, offset.1);
                self.update_mark(index, moved, window, cx);
            }
            cx.notify();
        }
    }

    /// The marks to draw, the ones changing under the pointer, and the chosen mark's bounds.
    pub(super) fn marks_for_picture(&self, cx: &App) -> (Vec<Mark>, Vec<Mark>, Option<draw::Rect>) {
        let marks = self.marks(cx);
        let moving = self
            .moving
            .as_ref()
            .filter(|moving| moving.offset != (0., 0.));
        let settled = marks
            .iter()
            .enumerate()
            .filter(|(index, _)| moving.is_none_or(|moving| moving.index != *index))
            .map(|(_, mark)| mark.clone())
            .collect();
        let moved = moving.and_then(|moving| {
            marks
                .get(moving.index)
                .map(|mark| mark.moved(moving.offset.0, moving.offset.1))
        });
        let drawn = self.drawing.as_ref().and_then(|drawing| {
            markup::dragged(
                self.tool,
                &drawing.points,
                &self.style,
                self.longest(cx),
                drawing.least,
            )
        });
        let live: Vec<Mark> = moved.clone().into_iter().chain(drawn).collect();
        let selection = moved
            .or_else(|| self.selected.and_then(|index| marks.get(index).cloned()))
            .map(|mark| mark.bounds());
        (settled, live, selection)
    }

    fn add_mark(
        &mut self,
        mark: Mark,
        edit_text: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.adding = Some(Adding {
            count: self.marks(cx).len(),
            edit_text,
        });
        let document = Some(self.id(cx));
        window.dispatch_action(AddMark { document, mark }.boxed_clone(), cx);
    }

    fn update_mark(&self, index: usize, mark: Mark, window: &mut Window, cx: &mut App) {
        let document = Some(self.id(cx));
        window.dispatch_action(
            UpdateMark {
                document,
                index,
                mark,
            }
            .boxed_clone(),
            cx,
        );
    }

    pub(super) fn toggle_markup(
        &mut self,
        _: &ToggleMarkup,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.markup = !self.markup;
        if !self.markup {
            // Hidden tools shouldn't keep drawing.
            self.tool = Tool::Select;
        }
        cx.notify();
    }

    pub(super) fn choose_tool(
        &mut self,
        action: &ChooseTool,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.tool = action.tool;
        self.markup = true;
        if action.tool != Tool::Select {
            self.selected = None;
            self.text_editor = None;
        }
        cx.notify();
    }

    /// Picks a palette color for new marks, and recolors the chosen mark. The highlighter keeps
    /// its own color, made translucent.
    pub(super) fn set_mark_color(
        &mut self,
        action: &SetMarkColor,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(&(_, color)) = Color::PALETTE.get(action.index) else {
            return;
        };
        let selected = self
            .selected
            .and_then(|index| Some((index, self.marks(cx).get(index)?.clone())));
        let highlighting = match &selected {
            Some((_, mark)) => matches!(mark, Mark::Highlight { .. }),
            None => self.tool == Tool::Highlight,
        };
        let color = if highlighting {
            translucent(color)
        } else {
            color
        };
        if highlighting {
            self.style.highlight = color;
        } else {
            self.style.ink = color;
        }
        if let Some((index, mark)) = selected {
            self.update_mark(index, mark.with_color(color), window, cx);
        }
        cx.notify();
    }

    /// Picks how thick new marks are, and changes the chosen mark to match.
    pub(super) fn set_thickness(
        &mut self,
        action: &SetThickness,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let thickness = action.thickness;
        self.style.thickness = thickness;
        let longest = self.longest(cx);
        if let Some(index) = self.selected
            && let Some(mark) = self.marks(cx).get(index)
        {
            let width = match mark {
                Mark::Text { .. } => thickness.text(longest),
                Mark::Highlight { .. } => thickness.highlight(longest),
                _ => thickness.line(longest),
            };
            self.update_mark(index, mark.with_width(width), window, cx);
        }
        cx.notify();
    }

    pub(super) fn delete_selected_mark(
        &mut self,
        _: &DeleteSelectedMark,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if let Some(index) = self.selected.take() {
            self.text_editor = None;
            let document = Some(self.id(cx));
            window.dispatch_action(DeleteMark { document, index }.boxed_clone(), cx);
            cx.notify();
        }
    }

    /// Lets go of the chosen mark, or puts the drawing tool down.
    pub(super) fn deselect_mark(
        &mut self,
        _: &DeselectMark,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.selected.take().is_none() {
            self.tool = Tool::Select;
        }
        self.text_editor = None;
        cx.notify();
    }

    pub(super) fn nudge_mark(
        &mut self,
        action: &NudgeMark,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(index) = self.selected else {
            return;
        };
        let Some(mark) = self.marks(cx).get(index).cloned() else {
            return;
        };
        let step = if action.fast { 10. } else { 1. };
        let (dx, dy) = match action.direction {
            Direction::Left => (-step, 0.),
            Direction::Right => (step, 0.),
            Direction::Up => (0., -step),
            Direction::Down => (0., step),
        };
        self.update_mark(index, mark.moved(dx, dy), window, cx);
    }

    /// Edits the chosen text mark's words in the line under the picture. Every change shows on
    /// the picture as it's typed; Enter or Escape finishes, and finishing with no words deletes
    /// the mark.
    pub(super) fn edit_mark_text(
        &mut self,
        _: &EditMarkText,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(index) = self.selected else {
            return;
        };
        let Some(Mark::Text { text, .. }) = self.marks(cx).get(index).cloned() else {
            return;
        };
        let input = cx.new(|cx| TextField::new(text, window, cx));
        let events = cx.subscribe_in(&input, window, move |this, input, event, window, cx| {
            let empty = input.read(cx).text().trim().is_empty();
            if matches!(event, TextFieldEvent::Confirm | TextFieldEvent::Cancel) && empty {
                this.selected = Some(index);
                this.delete_selected_mark(&DeleteSelectedMark, window, cx);
            }
            if this.text_editor.take().is_some() {
                window.focus(&this.focus_handle, cx);
                cx.notify();
            }
        });
        let changes = cx.observe_in(&input, window, move |this, input, window, cx| {
            let typed = input.read(cx).text().to_string();
            let Some(Mark::Text {
                at,
                text,
                size,
                color,
                bold,
                background,
            }) = this.marks(cx).get(index).cloned()
            else {
                return;
            };
            if typed != text && !typed.trim().is_empty() {
                let retyped = Mark::Text {
                    at,
                    text: typed,
                    size,
                    color,
                    bold,
                    background,
                };
                this.update_mark(index, retyped, window, cx);
            }
        });
        self.text_editor = Some(TextEditor {
            index,
            input,
            _events: events,
            _changes: changes,
        });
        cx.notify();
    }

    /// The markup tools, palette and thicknesses, shown under the toolbar.
    pub(super) fn render_markup_bar(&self, cx: &Context<Self>) -> impl IntoElement {
        let theme = cx.theme();
        let selected = self
            .selected
            .and_then(|index| self.marks(cx).get(index).cloned());
        let highlighting = match &selected {
            Some(mark) => matches!(mark, Mark::Highlight { .. }),
            None => self.tool == Tool::Highlight,
        };
        let current = if highlighting {
            self.style.highlight
        } else {
            self.style.ink
        };
        let tools = Grid::new("tools").cells(Tool::ALL.map(|tool| {
            GridCell::icon(tool.icon(), tool.label(), ChooseTool { tool }).on(self.tool == tool)
        }));
        let palette =
            Grid::new("palette").cells(Color::PALETTE.iter().enumerate().map(
                |(index, &(name, color))| {
                    let fill = rgba(
                        u32::from(color.r) << 24
                            | u32::from(color.g) << 16
                            | u32::from(color.b) << 8
                            | 0xff,
                    );
                    GridCell::swatch(fill.into(), capitalized(name), SetMarkColor { index })
                        .on(Color { a: 255, ..current } == color)
                },
            ));
        let thicknesses = Grid::new("thickness").cells(Thickness::ALL.map(|thickness| {
            let line = match thickness {
                Thickness::Thin => 1.,
                Thickness::Medium => 2.,
                Thickness::Thick => 4.,
            };
            GridCell::line(px(line), thickness.label(), SetThickness { thickness })
                .on(self.style.thickness == thickness)
        }));
        div()
            .h(px(40.))
            .flex_none()
            .px(px(10.))
            .flex()
            .items_center()
            .gap(px(8.))
            .border_b_1()
            .border_color(theme.border)
            .child(tools)
            .child(palette)
            .child(thicknesses)
            .child(div().flex_1())
            .child(
                Grid::new("delete").cell(
                    GridCell::icon(Icon::Trash, "Delete Mark", DeleteSelectedMark)
                        .disabled(selected.is_none()),
                ),
            )
    }
}
