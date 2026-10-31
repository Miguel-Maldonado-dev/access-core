OUTPUT_COUNT = 4
OUTPUT_ALIAS_MAX = 40
READER_COUNT = 4
CONTROL_BUTTONS = 4
EXIT_BUTTON_OUTPUTS = (0, 1)
MAX_CODE = 4294967295
SCHEMA_VERSION = 6
RECONNECT_SECONDS = 3.0

HOLDER_KINDS = ("persona", "domicilio")

# Tablas que se replican en la nube (llevan uuid, updated_at y origin, y disparan la bandeja).
REPLICATED_TABLES = ("holders", "cards", "controls", "control_buttons", "permissions",
                     "holder_permissions", "outputs")

SOURCE_CARD, SOURCE_RF, SOURCE_EXIT_BUTTON, SOURCE_PIN = 0, 1, 2, 3
# El 4 queda reservado para "Remota" (etapa 3 de la nube).
SOURCE_TEST = 5

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

# Bloqueo por intentos de PIN fallidos (por lector).
PIN_MAX_FAILURES = 5
PIN_FAILURE_WINDOW_S = 300
PIN_LOCKOUT_S = 300
