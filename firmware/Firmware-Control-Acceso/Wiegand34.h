#ifndef WIEGAND34_H
#define WIEGAND34_H

#include <Arduino.h>

class Wiegand34
{
  public:

    Wiegand34(uint8_t pinD0, uint8_t pinD1);

    void begin();

    // Indica si al menos una entrada usa una interrupcion PCINT.
    bool usingPinChangeInterrupts() const;

    bool available();

    uint8_t getBits();

    uint64_t getCode();

    uint16_t getFacility();

    uint16_t getCard();

    // Código completo de tarjeta:
    // (Facility << 16) | Card
    uint32_t getCardCode();

    void reset();


  private:

    uint8_t _pinD0;
    uint8_t _pinD1;

    volatile uint64_t _data;
    volatile uint8_t _bits;
    volatile unsigned long _lastPulse;
    volatile uint8_t _lastPinState;
    volatile bool _pcintD0;
    volatile bool _pcintD1;


    static const uint8_t MAX_LECTORES = 4;
    static Wiegand34* _instances[MAX_LECTORES];
    uint8_t _slot;

    void handleD0();
    void handleD1();
    static void ISR_D0_0();
    static void ISR_D1_0();
    static void ISR_D0_1();
    static void ISR_D1_1();
    static void ISR_D0_2();
    static void ISR_D1_2();
    static void ISR_D0_3();
    static void ISR_D1_3();

  public:
    // Uso interno: lo invocan los vectores PCINT de AVR.
    static void dispatchPCINT();
};


#endif
