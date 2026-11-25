#!/bin/sh
# OpenLogiFlow (.deb): instala los permisos udev y prepara uinput.
set -e
RULES_SRC="/opt/OpenLogiFlow/resources/linux/70-openlogiflow.rules"
if [ -f "$RULES_SRC" ]; then
  install -m 0644 "$RULES_SRC" /etc/udev/rules.d/70-openlogiflow.rules
fi
# uinput como módulo cargado al arrancar
modprobe uinput 2>/dev/null || true
echo uinput > /etc/modules-load.d/openlogiflow.conf
if command -v udevadm >/dev/null 2>&1; then
  udevadm control --reload-rules || true
  udevadm trigger --subsystem-match=hidraw --subsystem-match=input --subsystem-match=misc || true
fi
# El sandbox de Chromium (chrome-sandbox) necesita SUID root
if [ -f /opt/OpenLogiFlow/chrome-sandbox ]; then
  chown root:root /opt/OpenLogiFlow/chrome-sandbox && chmod 4755 /opt/OpenLogiFlow/chrome-sandbox
fi
exit 0
