# Capturing what a POS prints

The parser is only proven once it has read real tickets. This page is for the person at a
pilot venue who records the bytes a POS sends to its receipt printer, so they become
fixtures (`tests/fixtures/pos-printer/README.md`) and, later, live bills.

Capture at least: three ordinary guest checks, one with a discount or a comp, one with a
service charge, one reprint of the same check, one check with items added after a first
print, one paid receipt, one kitchen or bar ticket, and an end-of-day (Z) report. Photograph
each paper ticket next to its file name. Before anything leaves the venue, redact guest
names, phone numbers, card digits and staff names (see the fixtures README).

First check what kind of stream it is: `xxd capture.bin | head -40`. Readable item names
in the right-hand column mean text mode, which the parser reads. Long runs of
`1d 76 30` (GS v 0) or `1b 2a` (ESC *) with almost no text mean the POS prints the
receipt as an image: the parser then reports `kind: "image"` and the bridge cannot read
that POS without changing its printer driver (on Windows, a text or "device font"
driver setting) or adding OCR, which it does not have.

## 1. Network printers (port 9100): the listener in the middle

Most venues print over Ethernet to port 9100. Run the listener on a small always-on
machine (a Raspberry Pi or the manager's PC) on the same network, point the POS at that
machine's address instead of the printer's, and let the listener forward every byte to the
real printer while it keeps a copy:

```
cp tools/pos-printer/config.example.json tools/pos-printer/config.json
# edit: the printer's real address under "forward", "captureDir", "dryRun": true
node tools/pos-printer/listen.js --config tools/pos-printer/config.json
```

Every print job lands in `captureDir` as `<printer>-<time>.bin`, and in dry run the bill it
would have sent lands in `outDir`. If the real printer cannot be reached, the listener
closes the POS's connection at once, so the POS shows its usual printer error rather than
losing a ticket.

Without Node, `socat` does the same tee (Linux or macOS; one file per job):

```
socat TCP-LISTEN:9100,reuseaddr,fork \
  SYSTEM:'tee /var/aalayna/captures/$(date +%Y%m%d-%H%M%S-%N).bin | socat - TCP:192.168.1.50:9100'
```

To capture without touching the POS configuration, mirror the printer's switch port (or
use a hub) and record passively, then cut the payload out:

```
sudo tcpdump -i eth0 -w print.pcap 'tcp port 9100 and host 192.168.1.50'
tshark -r print.pcap -Y 'tcp.dstport == 9100 && tcp.len > 0' -T fields -e tcp.payload \
  | tr -d ':\n' | xxd -r -p > capture.bin
```

(This joins every job in the file into one stream; the parser splits it at each cut.)

## 2. Serial printers (RS-232)

Node cannot set a serial port's speed without a package, so the listener reads a serial
device that `stty` has already configured (the printer's speed is on its self-test page,
often 9600 or 19200, 8N1):

```
# Linux
stty -F /dev/ttyUSB0 9600 cs8 -cstopb -parenb raw -echo
# macOS
stty -f /dev/cu.usbserial-110 9600 cs8 -cstopb -parenb raw -echo
cat /dev/ttyUSB0 > capture.bin          # Ctrl-C after the ticket has printed
```

For a pass-through between the POS and the printer, use two USB-serial adapters (POS side
on `ttyUSB0`, printer side on `ttyUSB1`) and `socat`, which sets both speeds itself:

```
socat /dev/ttyUSB0,b9600,raw,echo=0 SYSTEM:'tee -a capture.bin > /dev/ttyUSB1'
```

or hand the bytes to the listener over TCP: `socat /dev/ttyUSB0,b9600,raw,echo=0
TCP:127.0.0.1:9100`. The listener's `"serial"` source reads the device directly (after
`stty`) and ends a job after `idleMs` of silence or at a cut.

## 3. USB printers

A USB receipt printer is driven by the POS computer itself, so the bytes are captured
there.

- **Windows**: install Wireshark with USBPcap, find the printer's root hub with
  `USBPcapCMD.exe` (interactive list), then:

  ```
  "C:\Program Files\USBPcap\USBPcapCMD.exe" -d \\.\USBPcap1 -o C:\aalayna\usb.pcap -A
  tshark -r C:\aalayna\usb.pcap -Y "usb.transfer_type == 0x03 && usb.endpoint_address.direction == 0" -T fields -e usb.capdata > usb.hex
  ```

  then on any machine: `tr -d ':\r\n' < usb.hex | xxd -r -p > capture.bin`.
- **Linux POS**: `sudo modprobe usbmon`, find the bus with `lsusb`, record with
  `sudo tcpdump -i usbmon1 -w usb.pcap`, and extract with the same `tshark` filter.
- **For live use**, put the printer behind a USB print server or plug it into the listener
  machine and set `"forward": {"path": "/dev/usb/lp0"}`; the POS then prints over the
  network to the listener.

## 4. Windows: print to file or keep the spool files

When the POS prints through the Windows spooler with the RAW data type (most ESC/POS
drivers and POS programs that write to the printer directly), the spool file is exactly
the printer stream:

1. Printer properties, Advanced: tick **Keep printed documents**.
2. Print the ticket, then, in an administrator PowerShell:

   ```
   New-Item -ItemType Directory -Force C:\aalayna\captures
   Copy-Item C:\Windows\System32\spool\PRINTERS\*.SPL C:\aalayna\captures\
   ```

3. Untick **Keep printed documents** afterwards.

Or add a second printer that writes each job to a file, and print a copy of the check to
it (most POS programs can print a check to a second printer):

```
Add-PrinterPort -Name "C:\aalayna\captures\ticket.prn"
Add-Printer -Name "Aalayna capture" -DriverName "Generic / Text Only" -PortName "C:\aalayna\captures\ticket.prn"
```

The file is overwritten by every job, so copy it after each ticket, or point the
listener's `"folder"` source at `C:\aalayna\captures`: it reads each new or changed file
once (by content), and moves it to `processed\` when `moveProcessed` is set. The
"Generic / Text Only" driver sends plain text without ESC/POS commands; the parser reads
that too, but alignment and double-size marks are lost, so prefer the spool files.

## Sending captures

Zip the `.bin` files with the photos and a note of the POS name and version, the printer
model, the paper width (58 or 80 mm) and the code page the printer's self-test page
lists. Code page numbers differ between printer brands (many clones put Arabic at
`ESC t 22` or `28`): set them in the profile's `"codePages"`, for example
`{"22": "cp864"}`.
