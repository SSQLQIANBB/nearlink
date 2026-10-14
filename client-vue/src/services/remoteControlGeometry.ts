export interface RemoteRectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface RemoteSize {
  width: number;
  height: number;
}
export interface RemoteControlGeometry {
  displayId: number;
  coordinateSpace: 'quartz-global-logical';
  displayBounds: RemoteRectangle;
  displayPixels: RemoteSize;
  rotationDegrees: 0 | 90 | 180 | 270;
  encodedSize: RemoteSize;
  contentRect: RemoteRectangle;
}
export interface RemoteControlLayout {
  screenId: 'primary';
  layoutVersion: number;
  geometry: RemoteControlGeometry;
}

function fields(value: unknown, expected: readonly string[]): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === expected.length &&
    expected.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}
const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);
const dimension = (value: unknown): value is number => finite(value) && value > 0 && value <= 16384;
function size(value: unknown): value is RemoteSize {
  return (
    fields(value, ['width', 'height']) &&
    dimension(value.width) &&
    dimension(value.height) &&
    Number.isInteger(value.width) &&
    Number.isInteger(value.height)
  );
}
function rectangle(value: unknown): value is RemoteRectangle {
  return (
    fields(value, ['x', 'y', 'width', 'height']) &&
    finite(value.x) &&
    finite(value.y) &&
    dimension(value.width) &&
    dimension(value.height)
  );
}

/** Copy a strictly validated layout in a canonical order for immutable comparison. */
export function parseRemoteControlLayout(value: unknown): RemoteControlLayout | null {
  if (
    !fields(value, ['screenId', 'layoutVersion', 'geometry']) ||
    value.screenId !== 'primary' ||
    !Number.isSafeInteger(value.layoutVersion) ||
    (value.layoutVersion as number) <= 0
  )
    return null;
  const geometry = value.geometry;
  if (
    !fields(geometry, [
      'displayId',
      'coordinateSpace',
      'displayBounds',
      'displayPixels',
      'rotationDegrees',
      'encodedSize',
      'contentRect',
    ]) ||
    !Number.isInteger(geometry.displayId) ||
    (geometry.displayId as number) <= 0 ||
    (geometry.displayId as number) > 0xffffffff ||
    geometry.coordinateSpace !== 'quartz-global-logical' ||
    !rectangle(geometry.displayBounds) ||
    geometry.displayBounds.width < 1 ||
    geometry.displayBounds.height < 1 ||
    Math.abs(geometry.displayBounds.x) > 1e6 ||
    Math.abs(geometry.displayBounds.y) > 1e6 ||
    !size(geometry.displayPixels) ||
    !size(geometry.encodedSize) ||
    !rectangle(geometry.contentRect) ||
    ![0, 90, 180, 270].includes(geometry.rotationDegrees as number)
  )
    return null;
  const { contentRect, encodedSize, displayBounds, displayPixels } = geometry;
  if (
    contentRect.x < 0 ||
    contentRect.y < 0 ||
    contentRect.x + contentRect.width > encodedSize.width ||
    contentRect.y + contentRect.height > encodedSize.height
  )
    return null;
  const copyRect = ({ x, y, width, height }: RemoteRectangle) => ({ x, y, width, height });
  const copySize = ({ width, height }: RemoteSize) => ({ width, height });
  return {
    screenId: 'primary',
    layoutVersion: value.layoutVersion as number,
    geometry: {
      displayId: geometry.displayId as number,
      coordinateSpace: 'quartz-global-logical',
      displayBounds: copyRect(displayBounds),
      displayPixels: copySize(displayPixels),
      rotationDegrees: geometry.rotationDegrees as RemoteControlGeometry['rotationDegrees'],
      encodedSize: copySize(encodedSize),
      contentRect: copyRect(contentRect),
    },
  };
}

export function sameRemoteControlLayout(first: RemoteControlLayout, second: RemoteControlLayout) {
  return JSON.stringify(first) === JSON.stringify(second);
}
