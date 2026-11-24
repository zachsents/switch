// A picture of one of this app's own windows, drawn by the app itself: the window's frame drawn
// in-process (cacheDisplayInRect) with its web view's own snapshot (WKWebView takeSnapshot) laid
// over it. Nothing is read off the screen, so no Screen Recording is asked for. The bun process
// loads it as dist/libswitch-snapshot.dylib (src/bun/extension.ts).
#import <AppKit/AppKit.h>
#import <WebKit/WebKit.h>

/** 1 written, 0 no web view, -1 the snapshot failed, -2 the file wasn't written. */
typedef void (*SnapshotDone)(int32_t status);

static WKWebView *biggestWebView(NSView *view) {
  WKWebView *best = [view isKindOfClass:[WKWebView class]] ? (WKWebView *)view : nil;
  for (NSView *sub in view.subviews) {
    WKWebView *found = biggestWebView(sub);
    if (found != nil &&
        (best == nil || found.bounds.size.width * found.bounds.size.height >
                            best.bounds.size.width * best.bounds.size.height)) {
      best = found;
    }
  }
  return best;
}

static NSData *composed(NSWindow *window, WKWebView *web, NSImage *page) {
  NSView *frame = window.contentView.superview ?: window.contentView;
  NSRect bounds = frame.bounds;
  NSBitmapImageRep *rep = [frame bitmapImageRepForCachingDisplayInRect:bounds];
  if (rep == nil) {
    return nil;
  }
  [frame cacheDisplayInRect:bounds toBitmapImageRep:rep];
  NSGraphicsContext *context = [NSGraphicsContext graphicsContextWithBitmapImageRep:rep];
  [NSGraphicsContext saveGraphicsState];
  NSGraphicsContext.currentContext = context;
  NSRect at = [frame convertRect:web.bounds fromView:web];
  if (frame.isFlipped) {
    at.origin.y = bounds.size.height - at.origin.y - at.size.height;
  }
  [page drawInRect:at fromRect:NSZeroRect operation:NSCompositingOperationCopy fraction:1];
  // The window's buttons sit over the page: drawn again on top of it.
  for (NSNumber *kind in @[ @(NSWindowCloseButton), @(NSWindowMiniaturizeButton), @(NSWindowZoomButton) ]) {
    NSButton *button = [window standardWindowButton:kind.unsignedIntegerValue];
    if (button == nil || button.hiddenOrHasHiddenAncestor) {
      continue;
    }
    NSRect r = [frame convertRect:button.bounds fromView:button];
    if (frame.isFlipped) {
      r.origin.y = bounds.size.height - r.origin.y - r.size.height;
    }
    [NSGraphicsContext saveGraphicsState];
    NSAffineTransform *move = [NSAffineTransform transform];
    [move translateXBy:r.origin.x yBy:r.origin.y];
    [move concat];
    [button displayRectIgnoringOpacity:button.bounds inContext:context];
    [NSGraphicsContext restoreGraphicsState];
  }
  [context flushGraphics];
  [NSGraphicsContext restoreGraphicsState];
  return [rep representationUsingType:NSBitmapImageFileTypeJPEG
                           properties:@{NSImageCompressionFactor : @0.85}];
}

/** Writes a JPEG of `window` (an NSWindow of this process) to `path`, then calls `done`. */
__attribute__((visibility("default"))) void switch_window_snapshot(void *window, const char *path,
                                                                   SnapshotDone done) {
  NSWindow *win = (__bridge NSWindow *)window;
  NSString *file = [NSString stringWithUTF8String:path];
  dispatch_async(dispatch_get_main_queue(), ^{
    WKWebView *web = biggestWebView(win.contentView);
    if (web == nil) {
      done(0);
      return;
    }
    WKSnapshotConfiguration *config = [[WKSnapshotConfiguration alloc] init];
    [web takeSnapshotWithConfiguration:config
                     completionHandler:^(NSImage *page, NSError *error) {
                       if (page == nil || error != nil) {
                         done(-1);
                         return;
                       }
                       NSData *jpeg = composed(win, web, page);
                       done(jpeg != nil && [jpeg writeToFile:file atomically:YES] ? 1 : -2);
                     }];
  });
}
