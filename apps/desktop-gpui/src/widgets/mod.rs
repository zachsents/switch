//! Widgets (the desktop's `widgets/` and `ui/widget-*.tsx`): the host that loads each widget's A2UI
//! surface from the core, the three catalogs that draw them in the house look, the column of a
//! space's widgets beside its chat, a widget in a chat, a widget in a window of its own, and the
//! pages (an extension's MCP App, a page the agent made) in a web view.

pub mod basic;
pub mod charts;
pub mod chat_widget;
pub mod column;
pub mod host;
pub mod house;
pub mod media;
pub mod functions;
pub mod page;
pub mod palette;
pub mod render;
pub mod window;
