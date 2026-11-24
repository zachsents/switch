// A picture of one of this app's own windows, drawn by the app itself: gpui's frame, rendered again
// off screen (Window::render_to_image), with each web view over it (WKWebView takeSnapshot) and the
// window's buttons drawn on top. Nothing is read off the screen, so no Screen Recording is asked for.
// build.rs compiles it into the app; src/platform/snapshot.rs calls it.
#import <AppKit/AppKit.h>
#import <WebKit/WebKit.h>

/** 1 written, -1 a picture couldn't be made, -2 the file wasn't written. */
typedef void (*SnapshotDone)(int32_t status, void *context);

/** Every web view showing in `view`, deepest last. */
static void webViewsIn(NSView *view, NSMutableArray<WKWebView *> *out) {
  if ([view isKindOfClass:[WKWebView class]] && !view.hiddenOrHasHiddenAncestor) {
    [out addObject:(WKWebView *)view];
  }
  for (NSView *sub in view.subviews) {
    webViewsIn(sub, out);
  }
}

/** `r`, in `root`'s coordinates, flipped to a bitmap's (origin at the bottom). */
static NSRect inBitmap(NSView *root, NSRect r) {
  if (root.isFlipped) {
    r.origin.y = root.bounds.size.height - r.origin.y - r.size.height;
  }
  return r;
}

static NSData *composed(NSWindow *window, NSData *pixels, int32_t width, int32_t height,
                        NSArray<WKWebView *> *webs, NSArray *pages) {
  NSView *root = window.contentView;
  NSBitmapImageRep *rep = [[NSBitmapImageRep alloc] initWithBitmapDataPlanes:NULL
                                                                  pixelsWide:width
                                                                  pixelsHigh:height
                                                               bitsPerSample:8
                                                             samplesPerPixel:4
                                                                    hasAlpha:YES
                                                                    isPlanar:NO
                                                              colorSpaceName:NSDeviceRGBColorSpace
                                                                 bytesPerRow:width * 4
                                                                bitsPerPixel:32];
  if (rep == nil || pixels.length < (NSUInteger)width * height * 4) {
    return nil;
  }
  memcpy(rep.bitmapData, pixels.bytes, (size_t)width * height * 4);
  // Drawn in points, as the window's views are.
  rep.size = root.bounds.size;
  NSGraphicsContext *context = [NSGraphicsContext graphicsContextWithBitmapImageRep:rep];
  [NSGraphicsContext saveGraphicsState];
  NSGraphicsContext.currentContext = context;
  for (NSUInteger i = 0; i < webs.count; i++) {
    id page = pages[i];
    if (![page isKindOfClass:[NSImage class]]) {
      continue;
    }
    WKWebView *web = webs[i];
    NSRect whole = inBitmap(root, [root convertRect:web.bounds fromView:web]);
    NSRect seen = inBitmap(root, [root convertRect:web.visibleRect fromView:web]);
    [NSGraphicsContext saveGraphicsState];
    [NSBezierPath clipRect:seen];
    [(NSImage *)page drawInRect:whole
                       fromRect:NSZeroRect
                      operation:NSCompositingOperationSourceOver
                       fraction:1];
    [NSGraphicsContext restoreGraphicsState];
  }
  // The window's buttons sit over the frame: drawn again on top of it.
  for (NSNumber *kind in @[ @(NSWindowCloseButton), @(NSWindowMiniaturizeButton), @(NSWindowZoomButton) ]) {
    NSButton *button = [window standardWindowButton:kind.unsignedIntegerValue];
    if (button == nil || button.hiddenOrHasHiddenAncestor) {
      continue;
    }
    NSRect r = inBitmap(root, [root convertRect:button.bounds fromView:button]);
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

/** Writes a JPEG of `window` (an NSWindow of this process) to `path`, from gpui's frame `rgba`
 * (`width` x `height` pixels), then calls `done` with `context`, on the main thread. */
__attribute__((visibility("default"))) void switch_window_snapshot(void *window, const uint8_t *rgba,
                                                                   int32_t width, int32_t height,
                                                                   const char *path, SnapshotDone done,
                                                                   void *context) {
  NSWindow *win = (__bridge NSWindow *)window;
  NSString *file = [NSString stringWithUTF8String:path];
  NSData *pixels = [NSData dataWithBytes:rgba length:(size_t)width * height * 4];
  dispatch_async(dispatch_get_main_queue(), ^{
    NSMutableArray<WKWebView *> *webs = [NSMutableArray array];
    webViewsIn(win.contentView, webs);
    NSMutableArray *pages = [NSMutableArray array];
    for (NSUInteger i = 0; i < webs.count; i++) {
      [pages addObject:[NSNull null]];
    }
    dispatch_group_t group = dispatch_group_create();
    for (NSUInteger i = 0; i < webs.count; i++) {
      dispatch_group_enter(group);
      [webs[i] takeSnapshotWithConfiguration:nil
                           completionHandler:^(NSImage *page, NSError *error) {
                             if (page != nil && error == nil) {
                               pages[i] = page;
                             }
                             dispatch_group_leave(group);
                           }];
    }
    dispatch_group_notify(group, dispatch_get_main_queue(), ^{
      NSData *jpeg = composed(win, pixels, width, height, webs, pages);
      if (jpeg == nil) {
        done(-1, context);
        return;
      }
      done([jpeg writeToFile:file atomically:YES] ? 1 : -2, context);
    });
  });
}
