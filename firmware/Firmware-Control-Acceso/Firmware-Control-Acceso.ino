#include <RCSwitch.h>
#include "Wiegand34.h"

// ------------------------------ Hardware ------------------------------
const uint32_t UART_BAUD_RATE = 115200UL;

// D2 (INT0) is reserved for the 433 MHz RF receiver.
const uint8_t RF_RECEIVER_PIN = 2;

const uint8_t READER_1_D0_PIN = 3;
const uint8_t READER_1_D1_PIN = 4;
const uint8_t READER_2_D0_PIN = 5;
const uint8_t READER_2_D1_PIN = 6;
const uint8_t READER_3_D0_PIN = 7;
const uint8_t READER_3_D1_PIN = 8;
const uint8_t READER_4_D0_PIN = 9;
const uint8_t READER_4_D1_PIN = 10;

const uint8_t RELAY_1_PIN = A0;
const uint8_t RELAY_2_PIN = A1;
const uint8_t RELAY_3_PIN = A2;
const uint8_t RELAY_4_PIN = A3;
const uint8_t RELAY_COUNT = 4;
const uint8_t RELAY_ACTIVE_STATE = HIGH;
const uint8_t RELAY_INACTIVE_STATE = LOW;

// Exit buttons use the internal pull-ups and are active LOW.
const uint8_t EXIT_BUTTON_1_PIN = 11;
const uint8_t EXIT_BUTTON_2_PIN = 12;
const uint8_t EXIT_BUTTON_COUNT = 2;
const uint32_t EXIT_BUTTON_DEBOUNCE_MS = 50UL;
const uint16_t EXIT_BUTTON_RELAY_TIME_MS = 3000;

// While a remote button is held the same code is received continuously; it is
// reported again only after this interval.
const uint32_t RF_REPEAT_INTERVAL_MS = 3000UL;

// Keypad (Hikvision DS-K1802EK): every key arrives as a 4-bit Wiegand burst,
// 0-9 for digits, 0x0A for * and 0x0B for #. Keys pressed less than the
// Wiegand idle window apart merge into one burst of 8, 12 or 16 bits.
const uint8_t KEYPAD_BURST_BITS = 4;
const uint8_t KEYPAD_MAX_MERGED_BITS = 16;
const uint8_t KEY_STAR = 0x0A;
const uint8_t KEY_HASH = 0x0B;
const uint8_t PIN_MAX_DIGITS = 6;
const uint32_t PIN_TIMEOUT_MS = 10000UL;

// ------------------------------ Protocol ------------------------------
const uint8_t SOF = 0xAA;
const uint8_t EOF_MARKER = 0x55;

const uint8_t CMD_CARD_READ = 0x10;
const uint8_t CMD_RF_READ = 0x11;
const uint8_t CMD_EXIT_BUTTON = 0x12;
const uint8_t CMD_PIN_READ = 0x13;
const uint8_t CMD_ACTIVATE_RELAY = 0x20;

const uint8_t READER_1 = 0;
const uint8_t READER_2 = 1;
const uint8_t READER_3 = 2;
const uint8_t READER_4 = 3;
const uint8_t READER_COUNT = 4;

const uint8_t RELAY_1 = 0;
const uint8_t RELAY_2 = 1;
const uint8_t RELAY_3 = 2;
const uint8_t RELAY_4 = 3;

// The Wiegand library is used only to obtain the card code.
Wiegand34 reader1(READER_1_D0_PIN, READER_1_D1_PIN);
Wiegand34 reader2(READER_2_D0_PIN, READER_2_D1_PIN);
Wiegand34 reader3(READER_3_D0_PIN, READER_3_D1_PIN);
Wiegand34 reader4(READER_4_D0_PIN, READER_4_D1_PIN);

// The RCSwitch library is used only to obtain the RF code.
RCSwitch rfReceiver = RCSwitch();

uint32_t lastRFCode = 0;
uint32_t lastRFSentAt = 0;
bool hasLastRFCode = false;

// Digits typed on each reader's keypad, sent when # is pressed.
struct PinEntry {
  uint8_t digits[PIN_MAX_DIGITS];
  uint8_t length;
  bool overflow;
  uint32_t lastKeyAt;
};

PinEntry pinEntries[READER_COUNT];

struct RelayState {
  uint8_t pin;
  bool active;
  uint32_t activatedAt;
  uint16_t duration;
};

RelayState relays[RELAY_COUNT] = {
  { RELAY_1_PIN, false, 0, 0 },
  { RELAY_2_PIN, false, 0, 0 },
  { RELAY_3_PIN, false, 0, 0 },
  { RELAY_4_PIN, false, 0, 0 }
};

struct ExitButtonState {
  uint8_t pin;
  uint8_t relay;
  uint8_t stableLevel;
  uint8_t lastReading;
  uint32_t lastChangeAt;
};

// The array index is the ButtonID reported to the controller.
ExitButtonState exitButtons[EXIT_BUTTON_COUNT] = {
  { EXIT_BUTTON_1_PIN, RELAY_1, HIGH, HIGH, 0 },
  { EXIT_BUTTON_2_PIN, RELAY_2, HIGH, HIGH, 0 }
};

enum RxState {
  RX_WAIT_SOF,
  RX_READ_CMD,
  RX_READ_RELAY,
  RX_READ_TIME_MSB,
  RX_READ_TIME_LSB,
  RX_READ_CHECKSUM,
  RX_READ_EOF
};

RxState rxState = RX_WAIT_SOF;
uint8_t rxCommand = 0;
uint8_t rxRelay = 0;
uint16_t rxTime = 0;
uint8_t rxCalculatedChecksum = 0;
uint8_t rxReceivedChecksum = 0;

// XORs a sequence of protocol bytes. SOF and EOF are never supplied here.
uint8_t checksum(const uint8_t *data, uint8_t length) {
  uint8_t value = 0;

  for (uint8_t index = 0; index < length; index++) {
    value ^= data[index];
  }

  return value;
}

void resetParser() {
  rxState = RX_WAIT_SOF;
  rxCommand = 0;
  rxRelay = 0;
  rxTime = 0;
  rxCalculatedChecksum = 0;
  rxReceivedChecksum = 0;
}

// Sends: SOF, CMD, reader id, four card bytes (MSB first), checksum, EOF.
void sendCard(uint8_t reader, uint32_t card) {
  uint8_t frame[9];

  frame[0] = SOF;
  frame[1] = CMD_CARD_READ;
  frame[2] = reader;
  frame[3] = (uint8_t)(card >> 24);
  frame[4] = (uint8_t)(card >> 16);
  frame[5] = (uint8_t)(card >> 8);
  frame[6] = (uint8_t)card;
  frame[7] = checksum(&frame[1], 6);
  frame[8] = EOF_MARKER;

  Serial.write(frame, sizeof(frame));
}

// Sends: SOF, CMD, four RF code bytes (MSB first), checksum, EOF.
void sendRFCode(uint32_t code) {
  uint8_t frame[8];

  frame[0] = SOF;
  frame[1] = CMD_RF_READ;
  frame[2] = (uint8_t)(code >> 24);
  frame[3] = (uint8_t)(code >> 16);
  frame[4] = (uint8_t)(code >> 8);
  frame[5] = (uint8_t)code;
  frame[6] = checksum(&frame[1], 5);
  frame[7] = EOF_MARKER;

  Serial.write(frame, sizeof(frame));
}

// Sends: SOF, CMD, button id, checksum, EOF.
void sendExitButton(uint8_t button) {
  uint8_t frame[5];

  frame[0] = SOF;
  frame[1] = CMD_EXIT_BUTTON;
  frame[2] = button;
  frame[3] = checksum(&frame[1], 2);
  frame[4] = EOF_MARKER;

  Serial.write(frame, sizeof(frame));
}

// Sends: SOF, CMD, reader id, digit count, six digit values (unused ones are
// 0), checksum, EOF. The count keeps leading zeros: 0123 differs from 123.
void sendPin(uint8_t reader, const PinEntry &entry) {
  uint8_t frame[12] = { 0 };

  frame[0] = SOF;
  frame[1] = CMD_PIN_READ;
  frame[2] = reader;
  frame[3] = entry.length;

  for (uint8_t index = 0; index < entry.length; index++) {
    frame[4 + index] = entry.digits[index];
  }

  frame[10] = checksum(&frame[1], 9);
  frame[11] = EOF_MARKER;

  Serial.write(frame, sizeof(frame));
}

// Starts or restarts the requested relay timer without blocking other work.
void activateRelay(uint8_t relay, uint16_t time) {
  if (relay >= RELAY_COUNT) {
    return;
  }

  RelayState &state = relays[relay];
  state.duration = time;
  state.activatedAt = millis();
  state.active = true;
  digitalWrite(state.pin, RELAY_ACTIVE_STATE);
}

// Independently turns off each relay after its requested interval.
void updateRelays() {
  uint32_t now = millis();

  for (uint8_t relay = 0; relay < RELAY_COUNT; relay++) {
    RelayState &state = relays[relay];

    if (state.active && (uint32_t)(now - state.activatedAt) >= state.duration) {
      digitalWrite(state.pin, RELAY_INACTIVE_STATE);
      state.active = false;
    }
  }
}

// Executes only a fully received, checksum-validated command frame.
void processFrame() {
  if (rxCommand == CMD_ACTIVATE_RELAY && rxRelay < RELAY_COUNT) {
    activateRelay(rxRelay, rxTime);
  }
}

// Receives UART one byte at a time. An incomplete or malformed frame is ignored.
void processSerial() {
  while (Serial.available() > 0) {
    uint8_t byteReceived = (uint8_t)Serial.read();

    switch (rxState) {
      case RX_WAIT_SOF:
        if (byteReceived == SOF) {
          rxState = RX_READ_CMD;
        }
        break;

      case RX_READ_CMD:
        if (byteReceived == CMD_ACTIVATE_RELAY) {
          rxCommand = byteReceived;
          rxCalculatedChecksum = byteReceived;
          rxState = RX_READ_RELAY;
        } else if (byteReceived == SOF) {
          // An SOF here is a safe re-synchronization point before a command.
          rxState = RX_READ_CMD;
        } else {
          resetParser();
        }
        break;

      case RX_READ_RELAY:
        rxRelay = byteReceived;
        rxCalculatedChecksum ^= byteReceived;
        rxState = RX_READ_TIME_MSB;
        break;

      case RX_READ_TIME_MSB:
        rxTime = (uint16_t)byteReceived << 8;
        rxCalculatedChecksum ^= byteReceived;
        rxState = RX_READ_TIME_LSB;
        break;

      case RX_READ_TIME_LSB:
        rxTime |= byteReceived;
        rxCalculatedChecksum ^= byteReceived;
        rxState = RX_READ_CHECKSUM;
        break;

      case RX_READ_CHECKSUM:
        rxReceivedChecksum = byteReceived;
        rxState = RX_READ_EOF;
        break;

      case RX_READ_EOF:
        if (byteReceived == EOF_MARKER && rxReceivedChecksum == rxCalculatedChecksum) {
          processFrame();
          resetParser();
        } else if (byteReceived == SOF) {
          // If EOF was lost, retain this possible start of the next frame.
          rxState = RX_READ_CMD;
        }
        else {
          resetParser();
        }
        break;
    }
  }
}

void clearPin(PinEntry &entry) {
  entry.length = 0;
  entry.overflow = false;
}

// Digits accumulate per reader; * starts over and # sends the PIN. Typing more
// than PIN_MAX_DIGITS digits invalidates the entry, so a longer code never
// opens with its first six digits.
void handleKey(uint8_t reader, uint8_t key) {
  PinEntry &entry = pinEntries[reader];

  if (key <= 9) {
    entry.lastKeyAt = millis();
    if (entry.length < PIN_MAX_DIGITS) {
      entry.digits[entry.length++] = key;
    } else {
      entry.overflow = true;
    }
  } else if (key == KEY_STAR) {
    clearPin(entry);
  } else if (key == KEY_HASH) {
    if (entry.length > 0 && !entry.overflow) {
      sendPin(reader, entry);
    }
    clearPin(entry);
  }
}

// A burst of 4, 8, 12 or 16 bits holds that many keys, oldest key in the high
// nibble; any other length is a card (26 and 34 bits are never multiples of 4).
// A card also drops any digits pending on that reader.
void processReader(uint8_t reader, Wiegand34 &wiegand) {
  if (!wiegand.available()) {
    return;
  }

  uint8_t bits = wiegand.getBits();
  uint64_t code = wiegand.getCode();
  uint32_t card = wiegand.getCardCode();
  wiegand.reset();

  if (bits % KEYPAD_BURST_BITS == 0 && bits <= KEYPAD_MAX_MERGED_BITS) {
    for (int8_t shift = bits - KEYPAD_BURST_BITS; shift >= 0; shift -= KEYPAD_BURST_BITS) {
      handleKey(reader, (uint8_t)((code >> shift) & 0x0F));
    }
  } else {
    clearPin(pinEntries[reader]);
    sendCard(reader, card);
  }
}

void processReaders() {
  processReader(READER_1, reader1);
  processReader(READER_2, reader2);
  processReader(READER_3, reader3);
  processReader(READER_4, reader4);
}

// Drops digits left unconfirmed for PIN_TIMEOUT_MS.
void expirePins() {
  uint32_t now = millis();

  for (uint8_t reader = 0; reader < READER_COUNT; reader++) {
    PinEntry &entry = pinEntries[reader];

    if ((entry.length > 0 || entry.overflow) &&
        (uint32_t)(now - entry.lastKeyAt) >= PIN_TIMEOUT_MS) {
      clearPin(entry);
    }
  }
}

// Filters the repetitions of a held button: the same code is sent at most once
// every RF_REPEAT_INTERVAL_MS, while a different code is sent immediately.
void processRF() {
  if (!rfReceiver.available()) {
    return;
  }

  uint32_t code = rfReceiver.getReceivedValue();
  rfReceiver.resetAvailable();

  // A zero value is an undecodable transmission.
  if (code == 0) {
    return;
  }

  uint32_t now = millis();

  if (!hasLastRFCode || code != lastRFCode ||
      (uint32_t)(now - lastRFSentAt) >= RF_REPEAT_INTERVAL_MS) {
    sendRFCode(code);
    lastRFCode = code;
    lastRFSentAt = now;
    hasLastRFCode = true;
  }
}

// A debounced press opens its relay directly, without waiting for the
// controller, and then reports the event for logging. Holding the button
// produces a single activation.
void processExitButtons() {
  uint32_t now = millis();

  for (uint8_t button = 0; button < EXIT_BUTTON_COUNT; button++) {
    ExitButtonState &state = exitButtons[button];
    uint8_t reading = digitalRead(state.pin);

    if (reading != state.lastReading) {
      state.lastReading = reading;
      state.lastChangeAt = now;
    } else if (reading != state.stableLevel &&
               (uint32_t)(now - state.lastChangeAt) >= EXIT_BUTTON_DEBOUNCE_MS) {
      state.stableLevel = reading;

      if (reading == LOW) {
        activateRelay(state.relay, EXIT_BUTTON_RELAY_TIME_MS);
        sendExitButton(button);
      }
    }
  }
}

void setup() {
  Serial.begin(UART_BAUD_RATE);

  for (uint8_t relay = 0; relay < RELAY_COUNT; relay++) {
    pinMode(relays[relay].pin, OUTPUT);
    digitalWrite(relays[relay].pin, RELAY_INACTIVE_STATE);
  }

  for (uint8_t button = 0; button < EXIT_BUTTON_COUNT; button++) {
    pinMode(exitButtons[button].pin, INPUT_PULLUP);
  }

  reader1.begin();
  reader2.begin();
  reader3.begin();
  reader4.begin();

  rfReceiver.enableReceive(digitalPinToInterrupt(RF_RECEIVER_PIN));
}

void loop() {
  processReaders();
  expirePins();
  processRF();
  processExitButtons();
  processSerial();
  updateRelays();
}
