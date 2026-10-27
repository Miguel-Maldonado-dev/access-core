# Protocolo UART — Panel de Control de Acceso

**Versión:** 2.2  
**UART:** 115200 8N1  
**MCU de E/S:** ATmega328P  
**Controlador principal:** ESP32 / Raspberry Pi

## 1. Arquitectura

El ATmega328P es responsable de la captura de Wiegand (tarjetas y teclado), RF 433 MHz, botones de salida y control físico de relevadores. El controlador principal realiza la autorización, lógica de negocio y logging.

**El ATmega no valida tarjetas, códigos RF ni PIN.**

```text
Wiegand 1–4 ──┐   (tarjeta y teclado)
RF 433 ───────┼──► ATmega328P ── UART ──► ESP32/Raspberry Pi
REX 1 ────────┤       │
REX 2 ────────┘       └────────► Relay 1 … Relay 4
```

Los botones REX son una excepción: **abren directamente desde el ATmega y no esperan autorización del controlador**. El evento se envía además al controlador para logging.

### Asignación de E/S

| Función | Pin | ID en el protocolo |
|---|---|---|
| UART hacia el controlador | D0 (RX) / D1 (TX) | — |
| Receptor RF 433 MHz | D2 (INT0) | — |
| Lector Wiegand 1 (D0 / D1) | D3 / D4 | ReaderID `0` |
| Lector Wiegand 2 (D0 / D1) | D5 / D6 | ReaderID `1` |
| Lector Wiegand 3 (D0 / D1) | D7 / D8 | ReaderID `2` |
| Lector Wiegand 4 (D0 / D1) | D9 / D10 | ReaderID `3` |
| Botón de salida 1 | D11 | ButtonID `0` |
| Botón de salida 2 | D12 | ButtonID `1` |
| Relevador 1 | A0 | RelayID `0` |
| Relevador 2 | A1 | RelayID `1` |
| Relevador 3 | A2 | RelayID `2` |
| Relevador 4 | A3 | RelayID `3` |

- Las salidas de relevador manejan un ULN2803 y son activas en `HIGH`: `HIGH` = relevador activado, `LOW` = en reposo. Al arrancar, todas quedan en reposo.
- Los lectores con teclado (Hikvision DS-K1802EK) envían cada tecla por las mismas líneas D0/D1 que las tarjetas, como una ráfaga Wiegand de 4 bits (ver sección 8).
- Los botones de salida usan la pull-up interna y se activan con `LOW` (botón conectado entre el pin y GND).
- D13, A4 y A5 quedan libres.

## 2. Configuración UART

```text
115200 baud
8 data bits
No parity
1 stop bit
No flow control
```

## 3. Delimitadores

```text
SOF = 0xAA   // Start Of Frame
EOF = 0x55   // End Of Frame
```

Todas las tramas tienen la forma:

```text
SOF ... PAYLOAD ... CHECKSUM EOF
```

El checksum no incluye SOF ni EOF.

## 4. Mapa de comandos

| CMD | Nombre | Dirección | Función |
|---|---|---|---|
| `0x10` | `CMD_CARD_READ` | ATmega → Controlador | Código Wiegand |
| `0x11` | `CMD_RF_READ` | ATmega → Controlador | Código RF 433 MHz |
| `0x12` | `CMD_EXIT_BUTTON` | ATmega → Controlador | Botón de salida |
| `0x13` | `CMD_PIN_READ` | ATmega → Controlador | PIN capturado en el teclado |
| `0x20` | `CMD_ACTIVATE_RELAY` | Controlador → ATmega | Activar relevador |

Rangos reservados:

| Rango | Uso |
|---|---|
| `0x14–0x1F` | Eventos futuros |
| `0x21–0x2F` | Comandos futuros |
| `0x30–0x3F` | Estado / heartbeat |
| `0x40–0x4F` | Configuración |
| `0x50–0x5F` | Diagnóstico |
| `0xF0–0xFF` | Pruebas / reservado |

## 5. CMD `0x10` — Lectura Wiegand

Dirección: **ATmega → Controlador**

```text
AA 10 RR C1 C2 C3 C4 CS 55
```

| Byte | Campo | Descripción |
|---:|---|---|
| 0 | SOF | `0xAA` |
| 1 | CMD | `0x10` |
| 2 | ReaderID | `0..3` |
| 3 | CardCode MSB | Byte más significativo |
| 4 | CardCode | Byte |
| 5 | CardCode | Byte |
| 6 | CardCode LSB | Byte menos significativo |
| 7 | Checksum | XOR |
| 8 | EOF | `0x55` |

ReaderID:

```text
0 = Reader 1
1 = Reader 2
2 = Reader 3
3 = Reader 4
```

El código es `uint32_t`, transmitido MSB primero.

Ejemplo:

```text
Código decimal: 8518511
Hex:            0x0081FB6F
Reader:         0
Checksum:       0x10 ^ 0x00 ^ 0x00 ^ 0x81 ^ 0xFB ^ 0x6F = 0x05

Trama:
AA 10 00 00 81 FB 6F 05 55
```

## 6. CMD `0x11` — Lectura RF 433 MHz

Dirección: **ATmega → Controlador**

Cada botón del control RF puede generar un código diferente. El ATmega debe enviar únicamente el código recibido; no debe interpretar qué botón representa ni validar autorización.

```text
AA 11 C1 C2 C3 C4 CS 55
```

| Byte | Campo | Descripción |
|---:|---|---|
| 0 | SOF | `0xAA` |
| 1 | CMD | `0x11` |
| 2 | RFCode MSB | Byte más significativo |
| 3 | RFCode | Byte |
| 4 | RFCode | Byte |
| 5 | RFCode LSB | Byte menos significativo |
| 6 | Checksum | XOR |
| 7 | EOF | `0x55` |

El código es `uint32_t`, transmitido MSB primero. Los controles comunes (EV1527 / PT2262) generan códigos de 24 bits, por lo que el byte más significativo normalmente es `00`.

Ejemplo:

```text
Código RF: 0xA1234567
Checksum:  0x11 ^ 0xA1 ^ 0x23 ^ 0x45 ^ 0x67 = 0xB1

Trama:
AA 11 A1 23 45 67 B1 55
```

El controlador mantiene la asociación entre códigos RF y acciones autorizadas.

### Repetición RF

Los controles RF transmiten el mismo código continuamente mientras el botón permanece presionado. El ATmega filtra estas repeticiones:

- El mismo código se envía como máximo una vez cada **3000 ms**, contados desde su último envío.
- Un código diferente al último enviado se envía de inmediato.
- Un código con valor `0` se descarta, porque corresponde a una transmisión que no se pudo decodificar.

Una pulsación corta genera un solo evento. Si el botón se mantiene presionado, el evento se repite cada 3000 ms:

```text
Botón presionado 10 s:

t = 0 s → AA 11 ...
t = 3 s → AA 11 ...
t = 6 s → AA 11 ...
t = 9 s → AA 11 ...
```

El controlador debe tolerar recibir el mismo código varias veces seguidas. Autorizarlo de nuevo solo reinicia el temporizador del relevador (ver sección 12).

## 7. CMD `0x12` — Botón de salida

Dirección: **ATmega → Controlador**

Los dos botones de salida son entradas físicas que activan directamente su relevador correspondiente.

```text
AA 12 BB CS 55
```

| Byte | Campo | Descripción |
|---:|---|---|
| 0 | SOF | `0xAA` |
| 1 | CMD | `0x12` |
| 2 | ButtonID | Identificador del botón |
| 3 | Checksum | XOR |
| 4 | EOF | `0x55` |

| ButtonID | Botón | Pin | Relevador que activa |
|---|---|---|---|
| `0` | Exit Button 1 | D11 | Relay 1 (RelayID `0`) |
| `1` | Exit Button 2 | D12 | Relay 2 (RelayID `1`) |

Ejemplo, botón 1:

```text
Checksum = 0x12 ^ 0x00 = 0x12

Trama:
AA 12 00 12 55
```

Ejemplo, botón 2:

```text
Checksum = 0x12 ^ 0x01 = 0x13

Trama:
AA 12 01 13 55
```

### Comportamiento

Al presionar el botón:

```text
Botón 1
   │
   ├──► ATmega ──► Relay 1 inmediatamente
   │
   └──► UART ──► Controlador ──► Log
```

El ATmega **NO debe esperar respuesta ni autorización del controlador**.

Esto garantiza que el botón siga funcionando si el ESP32/Raspberry Pi, red o servidor no están disponibles.

La entrada tiene un debounce de **50 ms**, por lo que una pulsación física produce:

```text
1 activación
1 evento de log
```

- El relevador se activa durante **3000 ms**. Este tiempo es fijo en el firmware (`EXIT_BUTTON_RELAY_TIME_MS`).
- Mantener el botón presionado no genera más activaciones ni eventos. Para una nueva apertura hay que soltarlo y volver a presionarlo.
- Si el relevador ya estaba activo, por ejemplo por un `0x20` del controlador, su temporizador se reinicia con 3000 ms.

## 8. CMD `0x13` — Lectura de PIN

Dirección: **ATmega → Controlador**

El lector con teclado Hikvision DS-K1802EK envía **cada tecla** como una ráfaga Wiegand de **4 bits**:

| Bits | Tecla |
|---|---|
| `0000`–`1001` | Dígitos `0`–`9` |
| `1010` | `*` (borrar) |
| `1011` | `#` (confirmar) |

El ATmega distingue tecla de tarjeta por la cantidad de bits. Una ráfaga de 4 bits es una tecla. Si dos o más teclas se presionan con menos de 100 ms entre ellas, llegan juntas en una ráfaga de 8, 12 o 16 bits: cada grupo de 4 bits es una tecla, la más antigua en los bits más significativos. Cualquier otra longitud es una tarjeta (`0x10`); las tarjetas de 26 y 34 bits nunca son múltiplo de 4. El ATmega acumula los dígitos **por lector** y envía el PIN completo solo al confirmar con `#`:

- Dígito: se agrega (máximo **6**). Si se escribe un séptimo dígito, la captura queda inválida y el siguiente `#` la descarta sin enviar nada, para que `1234567#` no abra con `123456`.
- `*`: borra lo escrito y permite volver a capturar.
- `#`: si hay de 1 a 6 dígitos válidos, envía la trama `0x13`; en cualquier caso, vacía la captura.
- Si pasan **10 s** sin presionar dígitos, lo escrito se descarta.
- Una tarjeta leída en ese mismo lector también descarta lo escrito.
- Las teclas `1100`–`1111` se ignoran y no reinician los 10 s.

```text
AA 13 RR LL D1 D2 D3 D4 D5 D6 CS 55
```

| Byte | Campo | Descripción |
|---:|---|---|
| 0 | SOF | `0xAA` |
| 1 | CMD | `0x13` |
| 2 | ReaderID | `0..3` |
| 3 | Length | Cantidad de dígitos, `1..6` |
| 4–9 | D1..D6 | Valor de cada dígito (`0x00`–`0x09`) en el orden escrito; los bytes después de `Length` van en `0x00` |
| 10 | Checksum | XOR |
| 11 | EOF | `0x55` |

`Length` conserva los ceros a la izquierda: `0123` y `123` son PIN distintos.

Ejemplo: teclas `1 2 3 4 5 6 #` en el lector 1:

```text
Checksum = 0x13 ^ 0x00 ^ 0x06 ^ 0x01 ^ 0x02 ^ 0x03 ^ 0x04 ^ 0x05 ^ 0x06 = 0x12

Trama:
AA 13 00 06 01 02 03 04 05 06 12 55
```

Ejemplo: teclas `0 1 2 3 #` en el lector 2:

```text
Checksum = 0x13 ^ 0x01 ^ 0x04 ^ 0x00 ^ 0x01 ^ 0x02 ^ 0x03 = 0x16

Trama:
AA 13 01 04 00 01 02 03 00 00 16 55
```

El controlador descarta como inválida una trama con `Length` fuera de `1..6`, un dígito mayor que 9, un lector mayor que 3 o un byte de relleno distinto de `0x00`. El controlador decide qué titular corresponde al PIN y si sus permisos lo aceptan; el ATmega no valida PIN.

## 9. CMD `0x20` — Activación de relevador

Dirección: **Controlador → ATmega**

Se utiliza cuando el controlador ya autorizó una tarjeta Wiegand, un código RF o un PIN.

```text
AA 20 RR T1 T2 CS 55
```

| Byte | Campo | Descripción |
|---:|---|---|
| 0 | SOF | `0xAA` |
| 1 | CMD | `0x20` |
| 2 | RelayID | `0..3` |
| 3 | Tiempo MSB | Tiempo en ms |
| 4 | Tiempo LSB | Tiempo en ms |
| 5 | Checksum | XOR |
| 6 | EOF | `0x55` |

```text
RelayID = 0 → Relay 1
RelayID = 1 → Relay 2
RelayID = 2 → Relay 3
RelayID = 3 → Relay 4
```

Una trama con RelayID fuera de rango (`4` o mayor) se descarta sin ejecutar acción.

El tiempo es `uint16_t`, MSB primero (máximo 65535 ms).

Ejemplos:

```text
1000 ms  = 03 E8
3000 ms  = 0B B8
5000 ms  = 13 88
10000 ms = 27 10
```

Ejemplo: Relay 2 durante 5000 ms:

```text
Checksum = 0x20 ^ 0x01 ^ 0x13 ^ 0x88 = 0xBA

Trama:
AA 20 01 13 88 BA 55
```

## 10. Checksum

Checksum XOR de todos los bytes desde CMD hasta el último byte del payload.

No incluir SOF ni EOF.

### Wiegand

```cpp
checksum = CMD ^ ReaderID ^ C1 ^ C2 ^ C3 ^ C4;
```

### RF

```cpp
checksum = CMD ^ C1 ^ C2 ^ C3 ^ C4;
```

### Botón

```cpp
checksum = CMD ^ ButtonID;
```

### PIN

```cpp
checksum = CMD ^ ReaderID ^ Length ^ D1 ^ D2 ^ D3 ^ D4 ^ D5 ^ D6;
```

### Relevador

```cpp
checksum = CMD ^ RelayID ^ TimeMSB ^ TimeLSB;
```

## 11. Máquina de estados UART

El receptor debe procesar bytes individualmente:

```text
WAIT_SOF
   ↓
READ_CMD
   ↓
READ_PAYLOAD
   ↓
READ_CHECKSUM
   ↓
READ_EOF
   ↓
VALIDATE
   ↓
EXECUTE
   ↓
WAIT_SOF
```

No asumir que una trama completa estará disponible en una sola llamada a `Serial.available()`.

Si SOF, CMD, payload, checksum o EOF son inválidos:

```text
Descartar trama
No ejecutar acción
Volver a WAIT_SOF
```

## 12. Control de relevadores

No utilizar `delay()`.

Utilizar `millis()` para controlar los tiempos.

Los cuatro relevadores deben poder funcionar simultáneamente e independientemente.

Si llega un nuevo comando para un relevador que ya está activo, se reinicia su temporizador con el nuevo tiempo. Lo mismo ocurre al presionar un botón de salida, que reinicia el temporizador de su relevador con 3000 ms.

## 13. Flujo de autorización

### Wiegand

```text
Tarjeta
  ↓
Lector Wiegand
  ↓
ATmega
  ↓
CMD_CARD_READ (0x10)
  ↓
Controlador
  ↓
Validación
  ↓
CMD_ACTIVATE_RELAY (0x20)
  ↓
ATmega
  ↓
Relay
```

### RF

```text
Control RF
  ↓
Receptor 433 MHz
  ↓
ATmega
  ↓
CMD_RF_READ (0x11)
  ↓
Controlador
  ↓
Validación
  ↓
CMD_ACTIVATE_RELAY (0x20)
  ↓
ATmega
  ↓
Relay
```

### PIN

```text
Teclas + #
  ↓
Lector con teclado (Wiegand 4 bits por tecla)
  ↓
ATmega (acumula dígitos)
  ↓
CMD_PIN_READ (0x13)
  ↓
Controlador
  ↓
Validación
  ↓
CMD_ACTIVATE_RELAY (0x20)
  ↓
ATmega
  ↓
Relay
```

### Botón de salida

```text
Botón
  ↓
ATmega
  ├──► Relay inmediatamente
  │
  └──► CMD_EXIT_BUTTON (0x12)
          ↓
      Controlador
          ↓
         Log
```

## 14. Responsabilidades

### ATmega

- Capturar Wiegand (tarjetas y teclas).
- Acumular el PIN por lector (`*` borra, `#` envía).
- Capturar RF y filtrar sus repeticiones.
- Detectar botones REX.
- Activar directamente el relay por REX.
- Ejecutar comandos de relay.
- Enviar eventos UART.
- No validar credenciales.

### ESP32 / Raspberry Pi

- Validar tarjetas.
- Validar códigos RF.
- Validar PIN.
- Aplicar reglas de acceso.
- Registrar eventos.
- Solicitar aperturas.
- Comunicación con sistemas externos.

## 15. Funciones del firmware

```cpp
void processReaders();
void processReader(uint8_t reader, Wiegand34 &wiegand);
void handleKey(uint8_t reader, uint8_t key);
void expirePins();
void processRF();
void processExitButtons();
void processSerial();
void processFrame();

void sendCard(uint8_t reader, uint32_t card);
void sendRFCode(uint32_t code);
void sendExitButton(uint8_t button);
void sendPin(uint8_t reader, const PinEntry &entry);

void activateRelay(uint8_t relay, uint16_t time);
void updateRelays();

uint8_t checksum(const uint8_t *data, uint8_t length);
```

## 16. Extensiones futuras

Se pueden agregar:

```text
0x14 → Contacto magnético
0x15 → Tamper
0x16 → Estado de puerta

0x21 → Control adicional de salida
0x22 → Configuración
0x23 → Reset

0x30 → Heartbeat
0x31 → Estado de relevadores
0x32 → Estado de entradas
0x33 → Información de firmware
```

## 17. Evolución del protocolo

La versión 2.2 utiliza tramas de longitud fija para simplificar implementación y pruebas.

Para futuras versiones con payloads variables se puede evolucionar a:

```text
SOF
LEN
CMD
PAYLOAD
CHECKSUM
EOF
```

También puede sustituirse XOR por CRC16 si posteriormente se requiere mayor protección contra errores.

## 18. Resumen

```text
ATmega → Controlador

AA 10 RR C1 C2 C3 C4 CS 55
       Wiegand (RR = 0..3)

AA 11 C1 C2 C3 C4 CS 55
       RF 433 MHz

AA 12 BB CS 55
       Botón de salida (BB = 0..1)

AA 13 RR LL D1 D2 D3 D4 D5 D6 CS 55
       PIN (RR = 0..3, LL = 1..6)


Controlador → ATmega

AA 20 RR T1 T2 CS 55
       Activar relevador (RR = 0..3)
```

### Principio fundamental

```text
Wiegand/RF/PIN:
ATmega captura
      ↓
Controlador autoriza
      ↓
ATmega activa relay


Botón de salida:
ATmega activa relay inmediatamente
      ↓
ATmega reporta evento
      ↓
Controlador registra log
```

## 19. Historial de cambios

| Versión | Cambios |
|---|---|
| 2.2 | Nuevo `0x13` (`CMD_PIN_READ`): PIN de 1 a 6 dígitos capturado en el teclado Hikvision DS-K1802EK (Wiegand de 4 bits por tecla; `*` borra, `#` envía, 10 s de inactividad descartan). Extensiones futuras recorridas a `0x14–0x16`. Relevadores activos en `HIGH` (ULN2803). |
| 2.1 | Se quitan los relevadores 5 y 6: cuatro relevadores (RelayID `0..3`). A4 y A5 quedan libres. |
| 2.0 | Seis relevadores (RelayID `0..5`). Tabla de asignación de E/S. Filtro de repetición RF de 3000 ms. Botones de salida en D11/D12 con debounce de 50 ms y apertura de 3000 ms. Corrección del ejemplo Wiegand (hex y checksum) y checksum calculado en el ejemplo RF. |
| 1.1 | Dos relevadores (RelayID `0..1`). |
