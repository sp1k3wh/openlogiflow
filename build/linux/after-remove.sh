#!/bin/sh
# OpenLogiFlow (.deb): quita los permisos udev al desinstalar.
rm -f /etc/udev/rules.d/70-openlogiflow.rules /etc/modules-load.d/openlogiflow.conf
command -v udevadm >/dev/null 2>&1 && udevadm control --reload-rules || true
exit 0
