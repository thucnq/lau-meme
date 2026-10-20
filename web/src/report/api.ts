import { SendError } from '../disc/api'
import { playerFetch, type PlayerOpts } from '../privacy/client'

/** Báo cáo phần tử hoặc ảnh (AC-REPORT-01..05). Goes through playerFetch: no consent, no request. */
export type ReportReason =
  | 'real_person'
  | 'politics_religion'
  | 'sexual'
  | 'discrimination'
  | 'violence_drugs_selfharm'
  | 'inappropriate_image'
  | 'other'

export const REASONS: Array<{ value: ReportReason; label: string }> = [
  { value: 'real_person', label: 'Người thật' },
  { value: 'politics_religion', label: 'Chính trị / tôn giáo' },
  { value: 'sexual', label: 'Tình dục' },
  { value: 'discrimination', label: 'Phân biệt / body shaming' },
  { value: 'violence_drugs_selfharm', label: 'Bạo lực / ma túy / tự hại' },
  { value: 'inappropriate_image', label: 'Ảnh không phù hợp' },
  { value: 'other', label: 'Khác' },
]

export type ReportRequest = { target: 'element' | 'image'; id: string; reason: ReportReason; note?: string }
export type Report = Omit<ReportRequest, 'note'> & { status: string; created_at: string }

export async function submitReport(req: ReportRequest, opts: PlayerOpts): Promise<Report> {
  const res = await playerFetch('api/reports', { method: 'POST', body: JSON.stringify(req) }, opts)
  if (!res.ok) throw new SendError(res.status)
  return (await res.json()) as Report
}
