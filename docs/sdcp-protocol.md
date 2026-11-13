# SDCP protocol reference (Centauri Carbon)

Reference for the local SDCP protocol as spoken by the Elegoo Centauri Carbon,
built from the printer's own web UI bundle (static pass) and from frames seen
on the wire (live pass). Each entry carries one of these labels:

- *static-only*: read from the web UI bundle, not yet seen on the wire.
- *observed*: seen in live traffic between Elegoo's web UI and the printer.
- *tested*: sent by this project's client and confirmed by the printer.

## Source artifacts

Captured on 2026-11-13 from `http://192.0.2.10/`. The files were downloaded
into a scratch directory outside the repository and treated as untrusted data;
they are not committed.

| Item | Value |
| --- | --- |
| Firmware | `V1.4.49` (UDP discovery reply, `FirmwareVersion`) |
| Protocol version | `V3.0.0` (UDP discovery reply, `ProtocolVersion`) |
| Mainboard id | `40551f980103d46c00004c0000000000` |

| File | Size (bytes) | SHA-256 |
| --- | ---: | --- |
| `main.f1485af82d8237b5b3c1.js` | 805227 | `1d74fa61d2b74efe14eecf1006c1f816e1803848fdb55435e00654bf6e7cb1eb` |
| `runtime.d8e385257819bb9e3f4a.js` | 2787 | `10f8f94977736b6b85a12178febd6631f4e1c9606a2257addb63991e15da18ea` |
| `polyfills.cbade4b333952df5eb42.js` | 33648 | `77843e84d1b61c2b68e282eb01da161d836f86974bc59be17f0b69ef031d666b` |
| `index.html` | 2166 | `333db73dce5ce223f42bb88c3b7e9c073ecf9835f9a0ea2eef68c1d495612527` |

When the firmware changes, download the new bundle, compare hashes, and re-run
the static pass (REA `compare_bundles`) before trusting this document.
