#include <RCSwitch.h>

RCSwitch mySwitch = RCSwitch();

// Evita reenviar por UART las tramas repetidas del mismo control.
unsigned long ultimoCodigo = 0;
unsigned int ultimosBits = 0;
unsigned int ultimoProtocolo = 0;
bool hayCodigoAnterior = false;

void setup() {
  Serial.begin(9600);
  mySwitch.enableReceive(0);  // Receiver on interrupt 0 => that is pin #2
}

void loop() {
  if (mySwitch.available()) {
    unsigned long codigo = mySwitch.getReceivedValue();
    unsigned int bits = mySwitch.getReceivedBitlength();
    unsigned int protocolo = mySwitch.getReceivedProtocol();

    // Solo manda la lectura si se recibió un código diferente al anterior.
    if (!hayCodigoAnterior || codigo != ultimoCodigo ||
        bits != ultimosBits || protocolo != ultimoProtocolo) {
      // Una sola línea por botón, lista para leer con Python.
      Serial.println(codigo);

      ultimoCodigo = codigo;
      ultimosBits = bits;
      ultimoProtocolo = protocolo;
      hayCodigoAnterior = true;
    }

    mySwitch.resetAvailable();
  }
}
