#include "Wiegand34.h"


Wiegand34* Wiegand34::_instances[Wiegand34::MAX_LECTORES] = { nullptr, nullptr, nullptr, nullptr };


// Constructor
Wiegand34::Wiegand34(uint8_t pinD0, uint8_t pinD1)
{
    _pinD0 = pinD0;
    _pinD1 = pinD1;

    _data = 0;
    _bits = 0;
    _lastPulse = 0;
    _lastPinState = 0x03;
    _pcintD0 = false;
    _pcintD1 = false;
    _slot = 0xFF;
}


// Inicializar
void Wiegand34::begin()
{
    // Se permiten hasta cuatro lectores. Reutilizar begin() sobre el mismo objeto no
    // ocupa otro registro.
    if (_slot == 0xFF) {
        for (uint8_t i = 0; i < MAX_LECTORES; i++) {
            if (_instances[i] == nullptr) {
                _instances[i] = this;
                _slot = i;
                break;
            }
        }
    }

    // No hay espacio para otro lector.
    if (_slot == 0xFF) {
        return;
    }


    pinMode(_pinD0, INPUT_PULLUP);
    pinMode(_pinD1, INPUT_PULLUP);


    // Se usa INT cuando esta disponible y PCINT para los demas pines AVR.
    const int interruptD0 = digitalPinToInterrupt(_pinD0);
    const int interruptD1 = digitalPinToInterrupt(_pinD1);

    if (interruptD0 != NOT_AN_INTERRUPT || interruptD1 != NOT_AN_INTERRUPT) {
        void (*isrD0)() = nullptr;
        void (*isrD1)() = nullptr;

        switch (_slot) {
            case 0: isrD0 = ISR_D0_0; isrD1 = ISR_D1_0; break;
            case 1: isrD0 = ISR_D0_1; isrD1 = ISR_D1_1; break;
            case 2: isrD0 = ISR_D0_2; isrD1 = ISR_D1_2; break;
            case 3: isrD0 = ISR_D0_3; isrD1 = ISR_D1_3; break;
        }

        if (interruptD0 != NOT_AN_INTERRUPT) attachInterrupt(interruptD0, isrD0, FALLING);
        if (interruptD1 != NOT_AN_INTERRUPT) attachInterrupt(interruptD1, isrD1, FALLING);
    }

#if defined(ARDUINO_ARCH_AVR) && defined(digitalPinToPCICR) && defined(digitalPinToPCMSK)
    noInterrupts();

    if (interruptD0 == NOT_AN_INTERRUPT) {
        volatile uint8_t *pcicr = digitalPinToPCICR(_pinD0);
        volatile uint8_t *pcmsk = digitalPinToPCMSK(_pinD0);
        if (pcicr != nullptr && pcmsk != nullptr) {
            *pcicr |= _BV(digitalPinToPCICRbit(_pinD0));
            *pcmsk |= _BV(digitalPinToPCMSKbit(_pinD0));
            _pcintD0 = true;
        }
    }

    if (interruptD1 == NOT_AN_INTERRUPT) {
        volatile uint8_t *pcicr = digitalPinToPCICR(_pinD1);
        volatile uint8_t *pcmsk = digitalPinToPCMSK(_pinD1);
        if (pcicr != nullptr && pcmsk != nullptr) {
            *pcicr |= _BV(digitalPinToPCICRbit(_pinD1));
            *pcmsk |= _BV(digitalPinToPCMSKbit(_pinD1));
            _pcintD1 = true;
        }
    }

    // PCINT notifica ambos flancos. Guardamos el estado inicial para atender
    // exclusivamente HIGH -> LOW, que es el pulso valido de Wiegand.
    _lastPinState = (digitalRead(_pinD0) ? 0x01 : 0x00)
                  | (digitalRead(_pinD1) ? 0x02 : 0x00);
    interrupts();
#endif
}


bool Wiegand34::usingPinChangeInterrupts() const
{
    return _pcintD0 || _pcintD1;
}


// D0 = bit 0
void Wiegand34::handleD0()
{
    _data <<= 1;
    _bits++;
    _lastPulse = millis();
}


// D1 = bit 1
void Wiegand34::handleD1()
{
    _data <<= 1;
    _data |= 1;
    _bits++;
    _lastPulse = millis();
}


void Wiegand34::ISR_D0_0() { if (_instances[0]) _instances[0]->handleD0(); }
void Wiegand34::ISR_D1_0() { if (_instances[0]) _instances[0]->handleD1(); }
void Wiegand34::ISR_D0_1() { if (_instances[1]) _instances[1]->handleD0(); }
void Wiegand34::ISR_D1_1() { if (_instances[1]) _instances[1]->handleD1(); }
void Wiegand34::ISR_D0_2() { if (_instances[2]) _instances[2]->handleD0(); }
void Wiegand34::ISR_D1_2() { if (_instances[2]) _instances[2]->handleD1(); }
void Wiegand34::ISR_D0_3() { if (_instances[3]) _instances[3]->handleD0(); }
void Wiegand34::ISR_D1_3() { if (_instances[3]) _instances[3]->handleD1(); }


// Atiende los tres grupos PCINT. Solo se procesan los pines registrados como
// PCINT y unicamente las transiciones HIGH -> LOW.
void Wiegand34::dispatchPCINT()
{
    for (uint8_t i = 0; i < MAX_LECTORES; i++) {
        Wiegand34 *lector = _instances[i];
        if (!lector) continue;

        const uint8_t currentState = (digitalRead(lector->_pinD0) ? 0x01 : 0x00)
                                   | (digitalRead(lector->_pinD1) ? 0x02 : 0x00);
        const uint8_t previousState = lector->_lastPinState;
        lector->_lastPinState = currentState;

        if (lector->_pcintD0 && (previousState & 0x01) && !(currentState & 0x01)) {
            lector->handleD0();
        }
        if (lector->_pcintD1 && (previousState & 0x02) && !(currentState & 0x02)) {
            lector->handleD1();
        }
    }
}


// Hay una tarjeta nueva
bool Wiegand34::available()
{
    // _lastPulse ocupa 4 bytes: se copia sin interrupciones para no leer un
    // valor a medias que parta una lectura en dos.
    noInterrupts();
    uint8_t bits = _bits;
    unsigned long lastPulse = _lastPulse;
    interrupts();

    return (bits > 0 && millis() - lastPulse > 100);
}


// Cantidad de bits
uint8_t Wiegand34::getBits()
{
    return _bits;
}


// Código Wiegand completo
uint64_t Wiegand34::getCode()
{
    return _data;
}


// Facility Code
uint16_t Wiegand34::getFacility()
{
    return (_data >> 17) & 0xFF;
}


// Número de tarjeta
uint16_t Wiegand34::getCard()
{
    return (_data >> 1) & 0xFFFF;
}


// Código impreso de tarjeta
// Ejemplo:
// Facility 129
// Card 64368
//
// (129 << 16) | 64368
//
// Resultado:
// 0008518512
//
uint32_t Wiegand34::getCardCode()
{
    uint32_t codigo;

    codigo = ((uint32_t)getFacility() << 16);
    codigo |= getCard();

    return codigo;
}


// Limpiar para siguiente lectura
void Wiegand34::reset()
{
    noInterrupts();

    _data = 0;
    _bits = 0;
    _lastPulse = 0;

    interrupts();
}


// Los vectores son globales porque asi los define el core AVR. Si otro modulo
// del proyecto usa PCINT, debe compartir estos vectores en vez de redefinirlos.
#if defined(ARDUINO_ARCH_AVR)
  #if defined(PCINT0_vect)
ISR(PCINT0_vect)
{
    Wiegand34::dispatchPCINT();
}
  #endif

  #if defined(PCINT1_vect)
ISR(PCINT1_vect)
{
    Wiegand34::dispatchPCINT();
}
  #endif

  #if defined(PCINT2_vect)
ISR(PCINT2_vect)
{
    Wiegand34::dispatchPCINT();
}
  #endif
#endif
