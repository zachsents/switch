//! Spaces (the desktop's `ui/settings/spaces.tsx` and `space-view.ts`): how each space with spaces
//! inside it lists them, banner rows or plain rows. Home first, then the rest warmest first. The
//! user's, per space, in the brain, shown at once.

use gpui::{AnyElement, App, ParentElement, Window, div, prelude::*};
use serde_json::json;

use crate::brain::HOME;
use crate::kit::{self, W40};
use crate::look::Look;
use crate::model::model;
use crate::spaces::{inside_banners, inside_key, set_pref, warmest};

pub fn render(window: &mut Window, cx: &mut App) -> AnyElement {
    let l = Look::get(cx);
    let m = model(cx).read(cx);
    let mut spaces: Vec<(String, String, bool)> = warmest(&m.brain)
        .into_iter()
        .filter(|x| m.derived.children.get(&x.id).is_some_and(|c| !c.is_empty()))
        .map(|x| (x.id.clone(), if x.id == HOME { "Home".to_string() } else { x.name.clone() }, inside_banners(&m.brain, &x.id)))
        .collect();
    spaces.sort_by_key(|x| x.0 != HOME);
    let rows: Vec<AnyElement> = spaces
        .into_iter()
        .map(|(id, name, banners)| {
            let key = inside_key(&id);
            kit::setting(name.clone(), W40, &l)
                .child(kit::controls().child(kit::segmented(format!("inside-{id}"), &name, &[("banners", "Banners"), ("rows", "Rows")], if banners { "banners" } else { "rows" }, &l, move |v, _, cx| {
                    set_pref(&key, json!(if v == "banners" { "banners" } else { "rows" }), cx)
                }, window, cx)))
                .into_any_element()
        })
        .collect();
    kit::pane_scroll("spaces", None, div().child(kit::group("Spaces", None, rows, &l)), window, cx)
}
