#!/usr/bin/env python3
"""Simulador ESP32 con UART y base relacional SQLite.

Configura usuarios, tarjetas, controles RF, permisos y salidas en
access_control_admin_gui.py. Este programa solo recibe eventos del panel,
los valida y manda el comando de relevador.
"""
import queue
import threading
import time
import tkinter as tk
from pathlib import Path
from tkinter import messagebox, ttk

from access_control_admin_gui import (
    SQLiteStore, LOG_EXIT_BUTTON, LOG_REASONS, LOG_SOURCE_CARD, LOG_SOURCE_EXIT_BUTTON,
    LOG_SOURCE_RF, LOG_UART_ERROR, READER_NAMES, OUTPUT_NAMES, EXIT_BUTTON_NAMES,
    EXIT_BUTTON_OUTPUTS,
)

SOF, EOF_MARKER = 0xAA, 0x55
CMD_CARD_READ, CMD_RF_READ, CMD_EXIT_BUTTON, CMD_ACTIVATE_RELAY = 0x10, 0x11, 0x12, 0x20
UART_BAUD_RATE = 115200
COMMAND_LENGTHS = {CMD_CARD_READ: 5, CMD_RF_READ: 4, CMD_EXIT_BUTTON: 1, CMD_ACTIVATE_RELAY: 3}


def checksum(data):
    result = 0
    for byte in data: result ^= byte
    return result


def format_frame(frame): return " ".join(f"{byte:02X}" for byte in frame)


def build_relay_command(relay, duration_ms):
    if relay not in range(len(OUTPUT_NAMES)) or not 0 <= duration_ms <= 65535: raise ValueError("Salida o duracion invalida.")
    body = bytes((CMD_ACTIVATE_RELAY, relay)) + duration_ms.to_bytes(2, "big")
    return bytes((SOF,)) + body + bytes((checksum(body), EOF_MARKER))


class FrameParser:
    def __init__(self): self.data = bytearray(); self.parameters = None
    def feed(self, byte):
        if not self.data:
            if byte == SOF: self.data.append(byte)
            return None
        if len(self.data) == 1:
            if byte in COMMAND_LENGTHS: self.data.append(byte); self.parameters = COMMAND_LENGTHS[byte]
            elif byte == SOF: self.data[:] = bytes((SOF,))
            else: self.data.clear()
            return None
        self.data.append(byte)
        if len(self.data) == self.parameters + 4:
            frame = bytes(self.data); self.data.clear(); self.parameters = None; return frame
        return None


class SerialWorker(threading.Thread):
    def __init__(self, port, frames, errors):
        super().__init__(daemon=True); self.port=port; self.frames=frames; self.errors=errors; self.stop_event=threading.Event(); self.lock=threading.Lock(); self.uart=None
    def run(self):
        try:
            import serial
            self.uart=serial.Serial(self.port, UART_BAUD_RATE, timeout=0.1); parser=FrameParser()
            while not self.stop_event.is_set():
                value=self.uart.read(1)
                if value:
                    frame=parser.feed(value[0])
                    if frame: self.frames.put(frame)
        except Exception as error: self.errors.put(str(error))
        finally:
            if self.uart: self.uart.close(); self.uart=None
    def send(self, frame):
        if not self.uart: raise RuntimeError("El puerto serie no esta conectado.")
        with self.lock: self.uart.write(frame); self.uart.flush()
    def stop(self): self.stop_event.set()


class AccessControlApp(tk.Tk):
    def __init__(self):
        super().__init__(); self.title("Control de acceso - Simulador ESP32 (SQLite)"); self.minsize(800, 520)
        self.store=SQLiteStore(Path(__file__).parent); self.frames=queue.Queue(); self.errors=queue.Queue(); self.worker=None; self.port=tk.StringVar(); self.status=tk.StringVar(value="Desconectado")
        self._build(); self.refresh_ports(); self.after(50,self.process); self.protocol("WM_DELETE_WINDOW",self.close)
    def _build(self):
        box=ttk.LabelFrame(self,text="Conexion UART",padding=10);box.pack(fill="x",padx=10,pady=10)
        ttk.Label(box,text="Puerto:").grid(row=0,column=0);self.combo=ttk.Combobox(box,textvariable=self.port,width=22);self.combo.grid(row=0,column=1,padx=5);ttk.Button(box,text="Actualizar",command=self.refresh_ports).grid(row=0,column=2,padx=5);self.button=ttk.Button(box,text="Conectar",command=self.toggle);self.button.grid(row=0,column=3,padx=5);ttk.Label(box,textvariable=self.status).grid(row=0,column=4,padx=10)
        info=ttk.LabelFrame(self,text="Configuracion",padding=10);info.pack(fill="x",padx=10,pady=(0,5));ttk.Label(info,text="Los usuarios, tarjetas, controles RF, permisos, lectores y duracion de salidas se administran en access_control_admin_gui.py. Esta pantalla solo monitorea y ejecuta los eventos UART.",wraplength=760).pack(anchor="w")
        frame=ttk.LabelFrame(self,text="Eventos del panel",padding=10);frame.pack(fill="both",expand=True,padx=10,pady=(0,10));frame.columnconfigure(0,weight=1);frame.rowconfigure(0,weight=1);self.log=tk.Text(frame,state="disabled",wrap="word");self.log.grid(row=0,column=0,sticky="nsew");bar=ttk.Scrollbar(frame,command=self.log.yview);bar.grid(row=0,column=1,sticky="ns");self.log["yscrollcommand"]=bar.set
    def refresh_ports(self):
        try:
            from serial.tools import list_ports
            ports=[p.device for p in list_ports.comports()]
        except ImportError: ports=[];self.log_event("pyserial no instalado: pip install pyserial")
        self.combo["values"]=ports
        if ports and not self.port.get(): self.port.set(ports[0])
    def toggle(self):
        if self.worker:
            self.worker.stop();self.worker=None;self.status.set("Desconectado");self.button.configure(text="Conectar");self.log_event("UART desconectada.");return
        if not self.port.get(): messagebox.showwarning("UART","Selecciona un puerto serie.");return
        self.worker=SerialWorker(self.port.get(),self.frames,self.errors);self.worker.start();self.status.set(f"Conectando a {self.port.get()}...");self.button.configure(text="Desconectar")
    def process(self):
        while not self.errors.empty():
            self.log_event("Error UART: " + self.errors.get_nowait());self.worker=None;self.status.set("Error de conexion");self.button.configure(text="Conectar")
        while not self.frames.empty(): self.handle_frame(self.frames.get_nowait())
        self.after(50,self.process)
    def handle_frame(self, frame):
        if frame[-1] != EOF_MARKER or frame[-2] != checksum(frame[1:-2]): self.log_event("Trama invalida: " + format_frame(frame));return
        handlers={CMD_CARD_READ:self.handle_card,CMD_RF_READ:self.handle_rf,CMD_EXIT_BUTTON:self.handle_exit_button}
        if frame[1] not in handlers: self.log_event("Trama recibida: " + format_frame(frame));return
        handlers[frame[1]](frame)
    def handle_card(self, frame):
        reader,card=frame[2],int.from_bytes(frame[3:7],"big")
        if reader not in range(len(READER_NAMES)): self.log_event(f"Lector invalido: {reader}");return
        self.activate(LOG_SOURCE_CARD,self.store.authorize_card(card,reader),card,reader,f"{READER_NAMES[reader]} | tarjeta {card}")
    def handle_rf(self, frame):
        code=int.from_bytes(frame[2:6],"big");access=self.store.authorize_rf(code);origin=f"Control RF | codigo {code}"
        if access.control_id is not None: origin+=f" | control {access.control_id} boton {access.button+1}"
        self.activate(LOG_SOURCE_RF,access,code,access.button,origin)
    def handle_exit_button(self, frame):
        # El panel ya abrio el relevador; aqui solo se registra el evento.
        button=frame[2]
        if button not in range(len(EXIT_BUTTON_NAMES)): self.log_event(f"Boton de salida invalido: {button}");return
        output=EXIT_BUTTON_OUTPUTS[button];self.store.append_log(LOG_SOURCE_EXIT_BUTTON,True,LOG_EXIT_BUTTON,device=button,output_id=output)
        self.log_event(f"BOTON DE SALIDA | {EXIT_BUTTON_NAMES[button]} -> {OUTPUT_NAMES[output]} | apertura local del panel, no se envia comando")
    def activate(self, source, access, code, device, origin):
        """Manda la activacion solo si el acceso fue autorizado y registra el resultado."""
        if not access.allowed:
            self.store.log_access(source,access,code,device);self.log_event(f"DENEGADO | {origin} | {access.user.name if access.user else '-'} | {LOG_REASONS[access.reason]}");return
        output=access.output
        try:
            command=build_relay_command(output.output_id,output.duration_ms)
            if not self.worker: raise RuntimeError("No hay UART conectada")
            self.worker.send(command);self.store.log_access(source,access,code,device);self.log_event(f"PERMITIDO | {access.user.name} | {origin} -> {OUTPUT_NAMES[output.output_id]}, {output.duration_ms} ms | {format_frame(command)}")
        except (ValueError,RuntimeError,OSError) as error: self.store.log_access(source,access,code,device,LOG_UART_ERROR);self.log_event("No se activo relevador: " + str(error))
    def log_event(self,text):
        self.log.configure(state="normal");self.log.insert("end",f"[{time.strftime('%H:%M:%S')}] {text}\n");self.log.see("end");self.log.configure(state="disabled")
    def close(self):
        if self.worker:self.worker.stop()
        self.store.close();self.destroy()

if __name__ == "__main__": AccessControlApp().mainloop()
