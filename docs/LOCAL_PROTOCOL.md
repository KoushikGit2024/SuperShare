# Local protocol, version 1

SuperShare transfers file data directly over the laptop's local TCP connection. The service does not need internet access or a cloud relay.

## Discovery

The Windows host sends a small UDP broadcast every five seconds to port `8766`. The announcement contains only the service name, protocol version, and TCP port. Android checks that version and uses the datagram source address to propose the laptop URL. If broadcast is blocked by the hotspot or firewall, use an address shown in the host dashboard or terminal.

## Pairing

`POST /api/pair` accepts a session code and a client-generated device ID, label, and platform. The host returns a device credential as a strict, HTTP-only cookie and a three-word verification phrase. The client compares that phrase with the host dashboard and calls `POST /api/devices/confirm-pairing`. The laptop user then grants send permission. The session code rotates when the server restarts; stored device credentials remain until revoked or forgotten.

## Upload sessions

1. `POST /api/transfers` creates a session with filename, size, destination-relative path, and collision decision.
2. `PUT /api/transfers/{id}/chunk` sends a chunk with `X-Chunk-Offset` and `X-Chunk-SHA256`. The server accepts only the next acknowledged offset and persists the chunk before advancing it.
3. `POST /api/transfers/{id}/complete` checks the full file and publishes it without replacement unless replacement was explicitly selected.
4. `GET /api/transfers/{id}` returns public job status; `POST /api/transfers/{id}/cancel` removes its partial file.

The current chunk size is 4 MiB and the active-job limit is two. Interrupted browser sessions can resume after the same file is reselected in the same browser profile. Failed jobs can restart from byte zero when the same file is reselected. Incomplete jobs and partial data are removed after seven days. The Android scaffold currently streams content URIs without staging but does not yet persist retry/resume state across app restarts.

## Security and current limits

Pairing and file transfer currently use local HTTP. Use only a trusted private hotspot until TLS and certificate verification are implemented. Discovery announcements are unauthenticated and contain no credentials. Pairing plus host approval remains required before file access. The current dashboard selects one host receive root; per-device roots are not implemented.
