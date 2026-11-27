export type HolderKind = "persona" | "domicilio";

export interface Holder {
  holder_id: number;
  kind: HolderKind;
  name: string;
  department: string;
  address: string;
  notes: string;
  has_pin: boolean;
  /** Solo viene en GET/POST/PUT de un titular, no en la lista. */
  pin?: string | null;
  permission_ids: number[];
  card_count: number;
  control_count: number;
}

export interface Permission {
  permission_id: number;
  name: string;
  output_mask: number;
  card_reader_mask: number;
  pin_reader_mask: number;
  qr_reader_mask: number;
  weekday_mask: number;
  start_minute: number;
  end_minute: number;
  allow_rf: boolean;
  allow_remote: boolean;
  allow_call: boolean;
}

export interface Output {
  output_id: number;
  duration_ms: number;
  reader_mask: number;
  enabled: boolean;
  alias: string;
}

export interface Card {
  card_code: number;
  holder_id: number;
  holder_name: string;
  holder_kind: HolderKind;
  description: string;
}

export interface ControlButton {
  rf_code: number | null;
  output_id: number | null;
}

export interface Control {
  control_id: number;
  holder_id: number;
  holder_name: string;
  holder_kind: HolderKind;
  description: string;
  buttons: ControlButton[];
}

export interface ListenResult {
  code: number | null;
  control: { control_id: number; description: string | null } | null;
}

export interface LogItem {
  log_id: number;
  timestamp: string;
  allowed: boolean;
  source: number;
  holder_id: number | null;
  holder_name: string | null;
  holder_kind: HolderKind | null;
  credential_label: string | null;
  control_id: number | null;
  code: number | null;
  device_id: number | null;
  output_id: number | null;
  reason: number;
}

export interface LogPage {
  items: LogItem[];
  total: number;
  page: number;
  page_size: number;
}

export interface Clock {
  now: string;
  timezone: string;
  ntp_synchronized: boolean | null;
}

export type CloudState = "unlinked" | "staging" | "awaiting_review" | "active";

export interface CloudStatus {
  panel_code: string | null;
  claim_code: string | null;
  state: CloudState;
  installation_name: string | null;
  last_sync_at: string | null;
  cloud_revision: number;
  pending_changes: number;
  last_error: string | null;
}

export interface Phone {
  phone_id: number;
  holder_id: number;
  holder_name: string;
  number: string;
  description: string;
}

export type CallMode = "single" | "menu";

export interface CallSettings {
  enabled: boolean;
  mode: CallMode;
  output_id: number;
  menu_mask: number;
  default_output: number | null;
  call_limit_per_minute: number;
}

export interface GsmStatus {
  ok: boolean;
  enabled: boolean | null;
  port: string | null;
  connected: boolean;
  registered: boolean | null;
  signal: number | null;
}

export type QrStatus = "pending" | "active" | "expired";

export interface QrCode {
  qr_id: number;
  holder_id: number;
  holder_name: string;
  code: number;
  label: string;
  valid_from: string;
  valid_until: string;
  max_uses: number;
  status: QrStatus;
  /** Lecturas válidas por lector (clave 0–3). */
  uses: Record<string, number>;
}

export interface QrSettings {
  digit: number;
  max_active: number;
  editable: boolean;
}
