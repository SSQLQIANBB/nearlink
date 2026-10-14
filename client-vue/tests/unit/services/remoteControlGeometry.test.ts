import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  parseRemoteControlLayout,
  sameRemoteControlLayout,
  type RemoteControlLayout,
} from '@/services/remoteControlGeometry';
import { remoteVideoCoordinates } from '@/services/remoteControlInput';

const fixtures = JSON.parse(
  readFileSync(resolve(process.cwd(), '../fixtures/remote-control-layout-v1.json'), 'utf8'),
).cases as Array<{
  name: string;
  layout: RemoteControlLayout;
  surface: { left: number; top: number; width: number; height: number };
  controllerCases: Array<{
    clientX: number;
    clientY: number;
    normalized: { x: number; y: number } | null;
  }>;
}>;
const fresh = () => structuredClone(fixtures[0]!.layout);
describe('远控内容矩形合同', () => {
  it('保留 Windows 物理像素坐标类型并沿用内容矩形映射', () => {
    const layout = fresh();
    layout.geometry.coordinateSpace = 'windows-desktop-physical';
    layout.geometry.displayBounds.width = layout.geometry.displayPixels.width;
    layout.geometry.displayBounds.height = layout.geometry.displayPixels.height;
    expect(parseRemoteControlLayout(layout)).toEqual(layout);
    const invalid = structuredClone(layout) as unknown as { geometry: { coordinateSpace: string } };
    invalid.geometry.coordinateSpace = 'unverified';
    expect(parseRemoteControlLayout(invalid)).toBeNull();
  });
  it.each(fixtures)('$name 与原生共享角点/中心及两层黑边样例', (fixture) => {
    const parsed = parseRemoteControlLayout(fixture.layout)!;
    expect(parsed).not.toBeNull();
    for (const point of fixture.controllerCases) {
      expect(
        remoteVideoCoordinates(
          point.clientX,
          point.clientY,
          fixture.surface,
          parsed.geometry.encodedSize.width,
          parsed.geometry.encodedSize.height,
          parsed.geometry,
        ),
      ).toEqual(point.normalized);
    }
  });
  it.each([0, 90, 180, 270] as const)(
    '旋转%d度、负原点和Retina不重复变换可见内容坐标',
    (rotationDegrees) => {
      const layout = fresh();
      layout.geometry.rotationDegrees = rotationDegrees;
      layout.geometry.displayBounds.x = -1440;
      const parsed = parseRemoteControlLayout(layout)!;
      expect(
        remoteVideoCoordinates(285, 379.375, fixtures[0]!.surface, 1280, 720, parsed.geometry),
      ).toEqual({ x: 0.25, y: 0.25 });
    },
  );
  it('支持有界小数内容矩形和CSS小数布局，且不放过矩形外像素', () => {
    const layout = fresh();
    layout.geometry.contentRect = { x: 64.25, y: 0.5, width: 1151.5, height: 719 };
    const parsed = parseRemoteControlLayout(layout)!;
    const surface = { left: 10.5, top: 20.25, width: 1280, height: 720 };
    expect(remoteVideoCoordinates(650.5, 380.25, surface, 1280, 720, parsed.geometry)).toEqual({
      x: 0.5,
      y: 0.5,
    });
    expect(remoteVideoCoordinates(74.74, 380.25, surface, 1280, 720, parsed.geometry)).toBeNull();
  });
  it('无布局、零解码尺寸或与声明不一致时拒绝映射', () => {
    const geometry = fresh().geometry,
      surface = fixtures[0]!.surface;
    for (const [width, height] of [
      [0, 0],
      [1920, 1080],
      [1280, 719],
    ])
      expect(remoteVideoCoordinates(510, 520, surface, width!, height!, geometry)).toBeNull();
    expect(remoteVideoCoordinates(510, 520, surface, 1280, 720, null)).toBeNull();
    expect(remoteVideoCoordinates(NaN, 520, surface, 1280, 720, geometry)).toBeNull();
  });
  it('每层未知字段、缺失字段、越界/非数值及非法坐标空间均被拒绝', () => {
    const mutations: Array<(layout: any) => void> = [
      (layout) => {
        layout.extra = true;
      },
      (layout) => {
        delete layout.geometry;
      },
      (layout) => {
        layout.screenId = 'other';
      },
      (layout) => {
        layout.layoutVersion = 0;
      },
      (layout) => {
        layout.layoutVersion = Number.MAX_SAFE_INTEGER + 1;
      },
      (layout) => {
        layout.geometry.extra = true;
      },
      (layout) => {
        layout.geometry.displayId = 0;
      },
      (layout) => {
        layout.geometry.displayId = 0x100000000;
      },
      (layout) => {
        layout.geometry.coordinateSpace = 'pixels';
      },
      (layout) => {
        layout.geometry.rotationDegrees = 45;
      },
      ...['displayBounds', 'contentRect', 'displayPixels', 'encodedSize'].map(
        (field) => (layout: any) => {
          layout.geometry[field].extra = true;
        },
      ),
      (layout) => {
        layout.geometry.displayBounds.x = -1000001;
      },
      (layout) => {
        layout.geometry.displayBounds.width = Infinity;
      },
      (layout) => {
        layout.geometry.displayBounds.width = 0.5;
      },
      (layout) => {
        layout.geometry.displayBounds.height = 0.5;
      },
      (layout) => {
        layout.geometry.displayPixels.width = 2880.5;
      },
      (layout) => {
        layout.geometry.encodedSize.width = 16385;
      },
      (layout) => {
        layout.geometry.contentRect.x = -1;
      },
      (layout) => {
        layout.geometry.contentRect.width = 0;
      },
      (layout) => {
        layout.geometry.contentRect.width = 1280;
      },
      (layout) => {
        layout.geometry.contentRect.y = NaN;
      },
    ];
    for (const mutate of mutations) {
      const layout = fresh();
      mutate(layout);
      expect(parseRemoteControlLayout(layout)).toBeNull();
    }
  });
  it('复制并规范字段顺序，原对象修改不能改动已验证布局', () => {
    const raw = fresh(),
      parsed = parseRemoteControlLayout(raw)!;
    const reordered = {
      geometry: raw.geometry,
      layoutVersion: raw.layoutVersion,
      screenId: raw.screenId,
    };
    expect(sameRemoteControlLayout(parsed, parseRemoteControlLayout(reordered)!)).toBe(true);
    raw.geometry.contentRect.x++;
    expect(parsed.geometry.contentRect.x).toBe(64);
    expect(sameRemoteControlLayout(parsed, parseRemoteControlLayout(raw)!)).toBe(false);
  });
});
