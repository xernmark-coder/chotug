# Weighing scales and barcode scanners — how they connect

## Short answer

| Device | Integrable? | How |
|---|---|---|
| **Barcode / QR gun** (USB or Bluetooth) | **Yes, today, no work** | It presents as a keyboard. Focus a scan field and pull the trigger. |
| **Weighbridge / platform scale** | **Yes** — the bridge is now built | An on-site agent reads the serial port and POSTs to `/api/devices/readings`. |
| **Printing a scannable QR label** | **Not yet** | Codes and payloads are generated; nothing renders a QR *image*. See "The one gap" below. |
| **Phone camera scanning** | **Not yet** | No camera code. Cheap to add where `BarcodeDetector` exists. |

---

## The weighing scale

### Why not straight from the browser

A weighbridge indicator speaks RS-232 or Modbus RTU. A browser cannot open a serial port —
WebSerial is Chrome-desktop only, HTTPS only, and needs a click every session. It would also stop
working the moment the internet did, which at a gate at 5 a.m. is the normal case, not the
exception.

So a small program runs on the PC beside the scale:

```
indicator ──RS-232 / Modbus──▶ site agent ──HTTPS──▶ /api/devices/readings
                                (buffers offline)          │
                                                           ▼
                                                   device_readings
                                                           │
                        the weighment screen ◀── /api/devices/latest
```

### What the agent has to do

1. **Check in** every minute so somebody can see it is alive:

```bash
curl -X POST https://<host>/api/devices/heartbeat \
  -H "X-Agent-Key: <the agent's key>" \
  -H 'content-type: application/json' \
  -d '{"agentVersion":"0.1.0","hostname":"gate-pc-01",
       "capabilities":["SCALE"],"bufferedEvents":0}'
```

2. **Post what the indicator says.** Batches are allowed, because the agent buffers when the link
   is down. Send `capturedAt` from the agent's clock — a two-minute upload delay must not look
   like a two-minute-old weight.

```bash
curl -X POST https://<host>/api/devices/readings \
  -H "X-Agent-Key: <key>" -H 'content-type: application/json' \
  -d '{"readings":[
        {"deviceCode":"WB-01","valueKg":5150,
         "rawReading":"ST,GS,   5150 kg","isStable":true,
         "capturedAt":"2026-08-18T14:04:43Z"}]}'
```

`isStable` matters. An indicator streams continuously while the lorry settles; only a frame the
scale itself marks stable (`ST` in the Toledo continuous format) is a weight. Unstable frames are
still stored — they are the evidence of what the scale was doing — but never offered as a weight.

3. That is all. The weighment screen calls `GET /api/devices/latest`, which returns only a
   **settled reading from the last 30 seconds**. Anything older belongs to the previous lorry, and
   offering it would save the wrong number with `capture_mode = SCALE`, which is worse than typing
   it.

### What the system does with it

- `scale_devices` holds the protocol, baud rate, parser key, capacity, least count, and the
  **Legal Metrology verification expiry**. A reading from a scale whose stamp has lapsed still
  comes through, flagged: *"the weight can be captured but should not be billed on."*
- `weighments.capture_mode` is `SCALE` or `MANUAL`, with `raw_reading` kept, and a database
  constraint (`ck_weigh_manual_reason`) that a typed weight may not claim a device reading.
- `01_schema` already indexes manual entry as a fraud signal. Until now every weight was manual,
  so that index had nothing to contrast against — it starts being meaningful the day a scale is
  wired in.
- A reading can be marked consumed (`POST /api/devices/readings/:id/consume`) so the same frame
  cannot back two documents.

### Security

The agent authenticates with a long-lived key in `X-Agent-Key`, stored only as a SHA-256 hash —
the database is not a list of working credentials. The key is scoped to one warehouse, and an
agent can be disabled without touching anyone's login. **Rotate the demo key
(`chotug-demo-agent-key`, seeded in `16_device_bridge.sql`) before any real scale is attached.**

### Parsers worth having

`parser_key` selects the agent-side parser. Common Indian weighbridge indicators:

| Indicator | Format | `parser_key` |
|---|---|---|
| Avery ZM301, Toledo | `ST,GS,  5150 kg` continuous | `toledo_continuous` |
| Essae-Teraoka | fixed-width ASCII, CR-terminated | `essae_ascii` |
| Sartorius / Mettler SICS | `S S      5150 kg` | `sics` |
| Modbus RTU indicators | holding registers, 2×16-bit | `modbus_rtu` |

---

## The barcode / QR gun

**Already works.** A USB or Bluetooth scanner is a keyboard: it types the code and presses Enter.
Every scan field in the app (`/p/:code`, the label trace box on Stock & Batches, the plot QR
screen) is a plain text input, so a gun works with no driver, no permission prompt and no code.

Two things make it better and neither is done:

### The one gap — nothing renders a QR image

`labels.code` and `labels.qr_payload` are generated at receipt and at harvest, and `/p/:code`
resolves a scan. But no QR *image* is produced anywhere — the codes exist only as text. So the
labels the system is designed around **cannot actually be printed and scanned**.

Fixing it is small: add a QR encoder (`qrcode` is ~50 KB and has no transitive dependencies),
render inline SVG on the label, and the existing scan routes light up. I have not added the
dependency without asking, since it is the first runtime package the web app would take on beyond
React, the router and Recharts.

### Camera scanning

Chrome and Android expose `BarcodeDetector` natively — roughly 30 lines, no dependency, with the
existing text field as the fallback where it is missing. Worth doing once labels are printable,
not before.
