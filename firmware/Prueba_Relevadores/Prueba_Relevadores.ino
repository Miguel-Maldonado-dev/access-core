// Prueba de hardware: enciende los 4 relevadores uno por uno, sin UART ni servidor.
// Mismos pines y nivel activo que Firmware-Control-Acceso (ULN2803 -> activo en HIGH).

const uint8_t RELAY_PINS[] = { A0, A1, A2, A3 };  // PC0..PC3
const uint8_t RELAY_COUNT = sizeof(RELAY_PINS);
const uint8_t RELAY_ACTIVE_STATE = HIGH;
const uint8_t RELAY_INACTIVE_STATE = LOW;
const uint16_t ON_MS = 2000;
const uint16_t OFF_MS = 1000;

void setup() {
  Serial.begin(115200);

  for (uint8_t relay = 0; relay < RELAY_COUNT; relay++) {
    pinMode(RELAY_PINS[relay], OUTPUT);
    digitalWrite(RELAY_PINS[relay], RELAY_INACTIVE_STATE);
  }
}

void loop() {
  for (uint8_t relay = 0; relay < RELAY_COUNT; relay++) {
    Serial.print("Relevador ");
    Serial.print(relay + 1);
    Serial.println(" ENCENDIDO");
    digitalWrite(RELAY_PINS[relay], RELAY_ACTIVE_STATE);
    delay(ON_MS);

    digitalWrite(RELAY_PINS[relay], RELAY_INACTIVE_STATE);
    Serial.println("  apagado");
    delay(OFF_MS);
  }
}
