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
  weekday_mask: number;
  start_minute: number;
  end_minute: number;
  allow_rf: boolean;
}

export interface Output {
  output_id: number;
  duration_ms: number;
  reader_mask: number;
  enabled: boolean;
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
