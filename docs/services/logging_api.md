# Logging API

The Va.Si.Li-Lab database API. Two jobs: serve scene and role definitions to the
VR client, and accept the continuous stream of tracking data, events and answers
that an interview produces, writing it to MongoDB.

Source: [Va.Si.Li-Lab-backend](https://github.com/texttechnologylab/Va.Si.Li-Lab-backend)
under `database-api/`. Published as
`docker.texttechnologylab.org/vasili/database-api:0.2`.

- **Port:** 16481
- **Storage:** external MongoDB
- **Docs:** Swagger UI at the service root

## Authentication

Every endpoint requires a shared secret in a header:

```
X-API-KEY: <value of X_API_KEY>
```

The same value must be set in `.env` and in the VR client's API asset. A mismatch
returns `401 Unauthorized` - and since logging failures do not interrupt an
interview, **a wrong key produces a session that appears to run perfectly and
records nothing.**

!!! danger "Verify logging before every study session"
    This is the failure mode most likely to cost you data. Confirm rows are
    arriving in MongoDB before a participant sits down, not after.

## Endpoints

### Logging - `/logging`

| Endpoint | Purpose |
|---|---|
| `POST /logging/player` | Player tracking sample - body, hands, audio, `localTime` |
| `POST /logging/object` | Object state and interaction |
| `POST /logging/special` | Free-form structured payload |
| `POST /logging/log` | General log entry |
| `POST /logging/playerLogIn` | Session start for a player |
| `POST /logging/playerRoleLogIn` | Role assignment - interviewer vs. interviewee |
| `POST /logging/levelChange` | Scene or level transition |
| `POST /logging/logMisc` | Miscellaneous events |
| `GET /logging/status` | Health check |

### Scene data - `/`

| Endpoint | Purpose |
|---|---|
| `GET/POST /scene`, `/scenes` | Scene definitions |
| `GET/POST /level`, `/levels` | Level definitions |
| `GET/POST /role`, `/roles` | Role definitions |
| `GET /level/locales`, `/role/locales` | Localisation strings |
| `GET /info` | Global info |

!!! note "Role assignment is worth watching"
    Roles arrive via `playerRoleLogIn`. If a client reconnects mid-session it may
    rejoin without a stable identity, and the interviewer/interviewee assignment
    can be lost for that segment. Check role continuity when analysing sessions
    that had a reconnection.

## Configuration

Set in `.env`, passed as environment variables:

| Variable | Purpose |
|---|---|
| `DB_SERVER`, `DB_PORT` | MongoDB host and port |
| `DB_NAME` | Database name |
| `DB_USERNAME`, `DB_PASSWORD` | MongoDB credentials |
| `X_API_KEY` | Shared secret for the header above |
| `PORT` | Listen port (16481) |

## Verifying

```bash
# without the key -> 401
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:16481/logging/status

# with the key -> success
curl -s -o /dev/null -w "%{http_code}\n" \
     -H "X-API-KEY: $(grep X_API_KEY .env | cut -d= -f2)" \
     http://localhost:16481/logging/status
```

If the authenticated call fails, the API cannot reach MongoDB - check
`docker compose logs database-api`.
