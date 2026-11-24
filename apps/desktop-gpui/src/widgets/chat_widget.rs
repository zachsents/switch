//! A widget shown in a chat, an app's or one the agent made (the desktop's `chat-widget.tsx`): the
//! whole column's width, rules above and below, its surface under its own key
//! (`<app>/<name>#<seq>`), its tool called with the line's input. Nothing shows until its surface is
//! in; one whose extension doesn't offer it shows nothing. A page the agent made opens at the height
//! it was made at, then fits what it draws (page.rs).

use gpui::{AnyElement, Context, IntoElement, ParentElement, Render, Styled, Window, div, px};

use crate::brain::Shown;
use crate::look::Look;
use crate::widgets::host::{Host, Source};
use crate::widgets::media::WebPictures;
use crate::widgets::render::{self, Ctx};

pub struct ChatWidget {
    shown: Shown,
    key: String,
}

impl ChatWidget {
    pub fn new(shown: Shown, seq: u64, cx: &mut Context<Self>) -> Self {
        let key = format!("{}/{}#{seq}", shown.app, shown.name);
        cx.observe(&Host::entity(cx), |_, _, cx| cx.notify()).detach();
        let pictures = WebPictures::entity(cx);
        cx.observe(&pictures, |_, _, cx| cx.notify()).detach();
        ChatWidget { shown, key }
    }

}

impl Render for ChatWidget {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let host = Host::entity(cx);
        let source = Source {
            app: self.shown.app.clone(),
            name: self.shown.name.clone(),
            input: (!self.shown.input.is_null()).then(|| self.shown.input.clone()),
        };
        let key = self.key.clone();
        host.update(cx, |h, cx| h.want(&key, source, cx));
        let Some(surface) = host.read(cx).surface(&self.key) else { return div().into_any_element() };
        let l = Look::get(cx);
        let ctx = Ctx::new(&self.key, surface, l);
        let drawn: AnyElement = render::surface(&ctx, window, cx);
        div()
            .w_full()
            .border_t(px(l.w_section))
            .border_b(px(l.w_section))
            .border_color(l.line_section)
            .child(drawn)
            .into_any_element()
    }
}
