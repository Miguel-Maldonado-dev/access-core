OUTPUT_COUNT = 4
OUTPUT_ALIAS_MAX = 40
READER_COUNT = 4
CONTROL_BUTTONS = 4
EXIT_BUTTON_OUTPUTS = (0, 1)
MAX_CODE = 4294967295
SCHEMA_VERSION = 9
RECONNECT_SECONDS = 3.0

HOLDER_KINDS = ("persona", "domicilio")

# Tablas que se replican en la nube (llevan uuid, updated_at y origin, y disparan la bandeja).
REPLICATED_TABLES = ("holders", "cards", "controls", "control_buttons", "permissions",
                     "holder_permissions", "outputs", "phones", "call_settings", "qr_codes")

SOURCE_CARD, SOURCE_RF, SOURCE_EXIT_BUTTON, SOURCE_PIN = 0, 1, 2, 3
SOURCE_REMOTE = 4  # "Remota": apertura ordenada desde la nube a nombre de un titular
SOURCE_TEST = 5
SOURCE_CALL = 6  # "Llamada": apertura por llamada telefónica (SIM808)
SOURCE_QR = 7  # "QR": código QR leído por un lector Wiegand

PIN_MIN_DIGITS, PIN_MAX_DIGITS = 4, 6

REASON_ALLOWED = 0
REASON_UNKNOWN_CARD = 1
REASON_NO_OUTPUT = 2
REASON_NO_PERMISSION = 3
REASON_UART_ERROR = 4
REASON_UNKNOWN_CONTROL = 5
REASON_BUTTON_NO_OUTPUT = 6
REASON_EXIT_BUTTON = 7
REASON_UNKNOWN_PIN = 8
REASON_PIN_NOT_ALLOWED = 9
REASON_PIN_LOCKED = 10
REASON_UNKNOWN_HOLDER = 11
REASON_UNKNOWN_PHONE = 12
REASON_CALL_LIMIT = 13
REASON_QR_UNKNOWN = 14
REASON_QR_EXPIRED = 15
REASON_QR_USED = 16
REASON_METHOD_NOT_ALLOWED = 17

# Códigos QR (leídos como tarjeta Wiegand de 34 bits).
QR_DEFAULT_DIGIT = 9
QR_DEFAULT_MAX_ACTIVE = 1000
QR_MAX_ACTIVE_LIMIT = 100000
QR_MAX_USES = 100
QR_LABEL_MAX = 60
QR_DEBOUNCE_S = 3.0
QR_RETENTION_DAYS = 30

# Apertura por llamada (SIM808).
CALL_MENU_TIMEOUT_S = 8
CALL_LIMIT_PER_MINUTE = 3
GSM_BAUD = 9600
CALL_MODES = ("single", "menu")

# Bloqueo por intentos de PIN fallidos (por lector).
PIN_MAX_FAILURES = 5
PIN_FAILURE_WINDOW_S = 300
PIN_LOCKOUT_S = 300
