// Where to put the plugin window so it sits in the bottom-right corner of the
// visible canvas. figma.ui.reposition takes canvas coordinates, while the
// window size is in screen pixels, so divide the size by the zoom.
export interface ViewportBounds {
    x: number;
    y: number;
    width: number;
    height: number;
}

export const PANEL_MARGIN_PX = 16;

export function bottomRightPosition(
    bounds: ViewportBounds,
    zoom: number,
    widthPx: number,
    heightPx: number,
): { x: number; y: number } {
    const z = zoom > 0 ? zoom : 1;
    const x = bounds.x + bounds.width - (widthPx + PANEL_MARGIN_PX) / z;
    const y = bounds.y + bounds.height - (heightPx + PANEL_MARGIN_PX) / z;
    return { x: Math.max(bounds.x, x), y: Math.max(bounds.y, y) };
}
