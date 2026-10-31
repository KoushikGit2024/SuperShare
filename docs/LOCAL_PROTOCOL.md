# Local protocol, version 1

SuperShare transfers file data directly over the laptop's local TCP connection. The service does not need internet access or a cloud relay.

## Discovery

The Windows host sends a small UDP broadcast every five seconds to port `8766`. The announcement contains only the service name, protocol version, and TCP port. Android checks that version and uses the datagram source address to propose the laptop URL. If broadcast is blocked by the hotspot or firewall, use an address shown in the host dashboard or terminal.

The host uses adapter names, IPv4 addresses, netmasks, and directed broadcast addresses from `psutil` when available. The dependency is listed in `requirements.txt`; a standard-library route-address fallback remains if adapter enumeration is unavailable.

## Pairing

`POST /api/pair` accepts a session code and a client-generated device ID, label, and platform. The host returns a device credential as a strict, HTTP-only cookie and a three-word verification phrase. The client compares that phrase with the host dashboard and calls `POST /api/devices/confirm-pairing`. The laptop user then grants send permission. The session code rotates when the server restarts; stored device credentials remain until revoked or forgotten.

## Upload sessions

1. `POST /api/transfers` creates a session with filename, size, destination-relative path, and collision decision.
2. `PUT /api/transfers/{id}/chunk` sends a chunk with `X-Chunk-Offset` and `X-Chunk-SHA256`. Chunks must be exactly 4 MiB except for the final chunk. The server accepts only the next acknowledged offset and persists the chunk before advancing it.
3. `POST /api/transfers/{id}/complete` checks each stored chunk against its acknowledged SHA-256, calculates the full file hash, and publishes it without replacement unless replacement was explicitly selected.
4. `GET /api/transfers/{id}` returns public job status; `POST /api/transfers/{id}/cancel` removes its partial file.

The current chunk size is 4 MiB and the active-job limit is two. The browser uses Web Crypto when available and a bounded pure-JavaScript SHA-256 fallback on local HTTP origins where Web Crypto is unavailable. Interrupted browser sessions can resume after the same file is reselected in the same browser profile. Android uploads persist session IDs and can resume when the same content URI is reopened; document-provider URI grants are persisted when supported. The foreground service provides an ongoing progress notification, but Android does not automatically restart work after killing the app process. Android downloads write directly to the selected destination and do not resume. Incomplete jobs and partial data are removed after seven days.

## Security and current limits

HTTP remains the default compatibility mode. For TLS, start with `python run.py --https`. SuperShare creates a local root CA in its private data directory, issues a host certificate with current adapter IP addresses, and prints the CA SHA-256 fingerprint. The Android app pins this fingerprint and still checks the certificate hostname. Browsers must trust the generated root CA certificate at the displayed path before using the HTTPS URL; do not ignore a fingerprint mismatch. Discovery broadcasts contain no pairing secret, but the broadcast itself is unauthenticated. Pairing plus host approval remains required before file access. The current dashboard selects one host receive root; per-device roots are not implemented.
