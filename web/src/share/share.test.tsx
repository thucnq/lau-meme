/**
 * Test chấp nhận cho SHARE (AC-SHARE-01..06). Web-only, không gọi server để vẽ thẻ.
 *
 * GIẢ ĐỊNH về module cần tạo (người cài đặt tạo đúng tên này):
 *   web/src/share/index.ts(x) xuất:
 *     formatShareTime(solveSeconds: number): string
 *       - làm tròn xuống phút; < 60 s => "dưới 1 phút"; có giờ => "26 giờ 03 phút" (phút 2 chữ số)
 *     buildDailyCardText(d: DailyCardData): string      // 3 dòng nối bằng "\n"
 *     buildDiscCardText(d: DiscCardData): string        // 2 dòng nối bằng "\n"
 *     drawCardPng(canvas: HTMLCanvasElement, card: 'daily' | 'discovery', data): void
 *       - đặt canvas.width = canvas.height = 1080 và vẽ bằng ctx.fillText
 *     ShareCard (React): <ShareCard card="daily" data={DailyCardData} /> hoặc
 *                        <ShareCard card="discovery" data={DiscCardData} />
 *       - nút "Chia sẻ", "Sao chép", "Lưu ảnh"; thông báo "Đã sao chép"; lỗi dùng role="alert"
 *       - "Chia sẻ": navigator.share({text, files?}) nếu có, files chỉ khi navigator.canShare({files}) true;
 *         không có navigator.share thì clipboard.writeText(text) (tính là method "copy")
 *       - "Lưu ảnh": tạo PNG từ canvas (toBlob) và tải xuống; method "image"
 *       - AbortError khi hủy bảng chia sẻ: im lặng, không sự kiện
 *   DailyCardData = { day: 'YYYY-MM-DD', batchHour: number, emoji: string, solveSeconds: number,
 *                     rank: number | null, link: string }   // link = trang chủ, thẻ nối thêm "?ref=daily"
 *   DiscCardData  = { emoji: string, name: string, nickname: string, link: string } // nối "?ref=disc"
 *   Sự kiện gửi qua playerFetch của '../privacy/client' (chặn khi chưa đồng ý, ném ConsentRequiredError):
 *     playerFetch('<base>api/events', { method:'POST', body: JSON {"events":[{type:'share',card,method}]} })
 *   Theo openapi: card của thẻ Công thức gia truyền là "discovery" (không phải "disc").
 * Chưa kiểm: nút chia sẻ nằm trong DailyPanel / Root (notice.first) - cần props thật, xem ghi chú trả lời.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const { playerFetch, ConsentRequiredError } = vi.hoisted(() => {
  class ConsentRequiredError extends Error {}
  return { playerFetch: vi.fn(), ConsentRequiredError };
});
vi.mock('../privacy/client', () => ({ playerFetch, ConsentRequiredError }));

import { ShareCard, buildDailyCardText, buildDiscCardText, drawCardPng, formatShareTime } from './index';

const TARGET = 'Cá Sấu Bombardiro';
const INPUT_A = 'Cá Mập';
const INPUT_B = 'Máy Bay';

const daily = {
  day: '2026-10-20',
  batchHour: 12,
  emoji: '📈',
  solveSeconds: 65 * 60 + 12,
  rank: 12 as number | null,
  link: 'https://laumeme.example/lau-meme/',
};
// Dữ liệu "bẩn": thêm trường đáp án để chắc chắn module không in ra.
const leakyDaily = { ...daily, targetName: TARGET, inputs: [INPUT_A, INPUT_B] } as typeof daily;

const disc = { emoji: '🧅', name: 'Ăn Hành', nickname: 'Bếp Trưởng', link: 'https://laumeme.example/lau-meme/' };
const leakyDisc = { ...disc, inputs: [INPUT_A, INPUT_B] } as typeof disc;

function mockCanvas() {
  const texts: string[] = [];
  const ctx = new Proxy(
    { fillText: vi.fn((t: string) => texts.push(String(t))), strokeText: vi.fn() } as Record<string, unknown>,
    {
      get: (o, k: string) => (k in o ? o[k] : (o[k] = vi.fn(() => ({ addColorStop: vi.fn(), width: 10 })))),
      set: (o, k: string, v) => ((o[k] = v), true),
    },
  );
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((cb: BlobCallback) =>
    cb(new Blob(['png'], { type: 'image/png' })),
  );
  return texts;
}

function setNav(share?: unknown, canShare?: unknown) {
  Object.defineProperty(navigator, 'share', { value: share, configurable: true, writable: true });
  Object.defineProperty(navigator, 'canShare', { value: canShare, configurable: true, writable: true });
}
const writeText = vi.fn();

function sentEvents() {
  return playerFetch.mock.calls
    .filter((c) => String(c[0]).includes('api/events'))
    .flatMap((c) => JSON.parse(String((c[1] as RequestInit).body)).events);
}

beforeEach(() => {
  playerFetch.mockReset().mockResolvedValue(new Response(null, { status: 202 }));
  writeText.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  setNav(undefined, undefined);
  Object.defineProperty(URL, 'createObjectURL', { value: vi.fn(() => 'blob:x'), configurable: true });
  Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('SHARE', () => {
  it('AC-SHARE-01: thẻ Daily dạng chữ đúng định dạng, không lộ đáp án', () => {
    const text = buildDailyCardText(leakyDaily);
    expect(text).toBe(
      'Lẩu Meme 🍲 Món đặc biệt 20/10 · mẻ 12h\n' +
        '📈 giải sau 1 giờ 05 phút · hạng #12\n' +
        'https://laumeme.example/lau-meme/?ref=daily',
    );
    for (const s of [TARGET, INPUT_A, INPUT_B]) expect(text).not.toContain(s);
  });

  it('AC-SHARE-01: chưa nộp được kết quả thì bỏ phần hạng', () => {
    const text = buildDailyCardText({ ...daily, rank: null });
    expect(text.split('\n')[1]).toBe('📈 giải sau 1 giờ 05 phút');
    expect(text).not.toContain('hạng');
    expect(text).not.toContain('#');
  });

  it('AC-SHARE-02: làm tròn xuống phút, dưới 1 phút, mẻ kéo dài', () => {
    expect(formatShareTime(45 * 60 + 8)).toBe('45 phút');
    expect(formatShareTime(26 * 3600 + 3 * 60)).toBe('26 giờ 03 phút');
    expect(formatShareTime(59)).toBe('dưới 1 phút');
    expect(formatShareTime(0)).toBe('dưới 1 phút');
    expect(buildDailyCardText({ ...daily, solveSeconds: 45 * 60 + 8 })).toContain('giải sau 45 phút');
    expect(buildDailyCardText({ ...daily, solveSeconds: 26 * 3600 + 180 })).toContain('giải sau 26 giờ 03 phút');
    // không còn chuỗi emoji các bước
    expect(buildDailyCardText(daily)).not.toMatch(/🟩|🟨|🟥|⬛|⬜/u);
  });

  it('AC-SHARE-03: PNG Daily 1080x1080 có logo, ngày + mẻ, emoji, thời gian, hạng, link; không lộ đáp án', () => {
    const texts = mockCanvas();
    const canvas = document.createElement('canvas');
    drawCardPng(canvas, 'daily', leakyDaily);
    expect(canvas.width).toBe(1080);
    expect(canvas.height).toBe(1080);
    const all = texts.join(' | ');
    for (const part of ['Lẩu Meme', '20/10', '12h', '📈', '1 giờ 05 phút', '#12', 'laumeme.example']) {
      expect(all).toContain(part);
    }
    for (const s of [TARGET, INPUT_A, INPUT_B]) expect(all).not.toContain(s);

    const t2 = mockCanvas();
    drawCardPng(document.createElement('canvas'), 'daily', { ...daily, rank: null });
    expect(t2.join(' ')).not.toContain('#');
  });

  it('AC-SHARE-04: thẻ Công thức gia truyền có chữ, link ?ref=disc và PNG 1080x1080, không lộ đầu vào', () => {
    const text = buildDiscCardText(leakyDisc);
    expect(text).toBe(
      'Mình là người đầu tiên nấu ra 🧅 Ăn Hành trên Lẩu Meme - Công thức gia truyền của Bếp Trưởng\n' +
        'https://laumeme.example/lau-meme/?ref=disc',
    );
    for (const s of [INPUT_A, INPUT_B]) expect(text).not.toContain(s);

    const texts = mockCanvas();
    const canvas = document.createElement('canvas');
    drawCardPng(canvas, 'discovery', leakyDisc);
    expect(canvas.width).toBe(1080);
    expect(canvas.height).toBe(1080);
    const all = texts.join(' | ');
    for (const part of ['Ăn Hành', 'Bếp Trưởng', '🧅']) expect(all).toContain(part);
    for (const s of [INPUT_A, INPUT_B]) expect(all).not.toContain(s);
  });

  it('AC-SHARE-05: có navigator.share, canShare cho file thì chia sẻ chữ kèm ảnh', async () => {
    mockCanvas();
    const share = vi.fn().mockResolvedValue(undefined);
    setNav(share, vi.fn(() => true));
    render(<ShareCard card="daily" data={daily} />);
    fireEvent.click(screen.getByRole('button', { name: /Chia sẻ/ }));
    await waitFor(() => expect(share).toHaveBeenCalledTimes(1));
    const arg = share.mock.calls[0]?.[0];
    expect(arg.text).toBe(buildDailyCardText(daily));
    expect(arg.files).toHaveLength(1);
    expect(arg.files[0].type).toBe('image/png');
    expect(writeText).not.toHaveBeenCalled();
  });

  it('AC-SHARE-05: canShare không cho file thì chỉ chia sẻ chữ', async () => {
    mockCanvas();
    const share = vi.fn().mockResolvedValue(undefined);
    setNav(share, vi.fn(() => false));
    render(<ShareCard card="daily" data={daily} />);
    fireEvent.click(screen.getByRole('button', { name: /Chia sẻ/ }));
    await waitFor(() => expect(share).toHaveBeenCalledTimes(1));
    const arg = share.mock.calls[0]?.[0];
    expect(arg.text).toBe(buildDailyCardText(daily));
    expect(arg.files ?? []).toHaveLength(0);
  });

  it('AC-SHARE-05: không có navigator.share thì chép chữ vào clipboard và báo "Đã sao chép"', async () => {
    mockCanvas();
    render(<ShareCard card="daily" data={daily} />);
    fireEvent.click(screen.getByRole('button', { name: /Chia sẻ/ }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(buildDailyCardText(daily)));
    expect(await screen.findByText('Đã sao chép')).toBeTruthy();
  });

  it('AC-SHARE-05: "Sao chép" luôn chép chữ dù có navigator.share, và báo "Đã sao chép"', async () => {
    mockCanvas();
    const share = vi.fn().mockResolvedValue(undefined);
    setNav(share, vi.fn(() => true));
    render(<ShareCard card="discovery" data={disc} />);
    fireEvent.click(screen.getByRole('button', { name: /Sao chép/ }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(buildDiscCardText(disc)));
    expect(share).not.toHaveBeenCalled();
    expect(await screen.findByText('Đã sao chép')).toBeTruthy();
  });

  it('AC-SHARE-05: người dùng hủy bảng chia sẻ (AbortError) thì không báo lỗi', async () => {
    mockCanvas();
    const share = vi.fn().mockRejectedValue(new DOMException('cancel', 'AbortError'));
    setNav(share, vi.fn(() => false));
    render(<ShareCard card="daily" data={daily} />);
    fireEvent.click(screen.getByRole('button', { name: /Chia sẻ/ }));
    await waitFor(() => expect(share).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText('Đã sao chép')).toBeNull();
    expect(sentEvents()).toHaveLength(0);
  });

  it('AC-SHARE-06: chia sẻ hệ thống thành công gửi share/daily/native qua client có kiểm đồng ý', async () => {
    mockCanvas();
    setNav(vi.fn().mockResolvedValue(undefined), vi.fn(() => false));
    render(<ShareCard card="daily" data={daily} />);
    fireEvent.click(screen.getByRole('button', { name: /Chia sẻ/ }));
    await waitFor(() => expect(sentEvents()).toEqual([{ type: 'share', card: 'daily', method: 'native' }]));
    const [, init] = playerFetch.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('POST');
  });

  it('AC-SHARE-06: sao chép thẻ Công thức gia truyền gửi share/discovery/copy', async () => {
    mockCanvas();
    render(<ShareCard card="discovery" data={disc} />);
    fireEvent.click(screen.getByRole('button', { name: /Sao chép/ }));
    await waitFor(() => expect(sentEvents()).toEqual([{ type: 'share', card: 'discovery', method: 'copy' }]));
  });

  it('AC-SHARE-06: lưu ảnh gửi share/daily/image', async () => {
    mockCanvas();
    render(<ShareCard card="daily" data={daily} />);
    fireEvent.click(screen.getByRole('button', { name: /Lưu ảnh/ }));
    await waitFor(() => expect(sentEvents()).toEqual([{ type: 'share', card: 'daily', method: 'image' }]));
  });

  it('AC-SHARE-06: chưa đồng ý (ConsentRequiredError) thì không gửi, chia sẻ vẫn chạy và không báo lỗi', async () => {
    mockCanvas();
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    playerFetch.mockRejectedValue(new ConsentRequiredError('consent'));
    render(<ShareCard card="daily" data={daily} />);
    fireEvent.click(screen.getByRole('button', { name: /Sao chép/ }));
    expect(await screen.findByText('Đã sao chép')).toBeTruthy();
    expect(writeText).toHaveBeenCalled();
    expect(screen.queryByRole('alert')).toBeNull();
    // không đi đường vòng qua fetch trần
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
