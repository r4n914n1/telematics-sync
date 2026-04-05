# Cloud Run + Cloud Scheduler (60s)

## 1) Priprema promenljivih

Zameni vrednosti po potrebi:

- PROJECT_ID: tvoj GCP projekat
- REGION: npr. europe-west1
- SERVICE_NAME: telematics-sync
- FIREBASE_DB_URL: Firebase Realtime DB URL

## 2) Ukljuci API-je

```bash
gcloud services enable run.googleapis.com cloudscheduler.googleapis.com cloudbuild.googleapis.com
```

## 3) Deploy na Cloud Run

```bash
gcloud run deploy telematics-sync \
  --source . \
  --region europe-west1 \
  --allow-unauthenticated \
  --set-env-vars FIREBASE_DB_URL=https://apprd-6e6da-default-rtdb.europe-west1.firebasedatabase.app,REQUIRE_ACTIVE_BROWSER=false
```

Napomena:
- REQUIRE_ACTIVE_BROWSER=false znaci da scheduler uvek radi sync na 60s.
- Ako hoces uslov "samo kad je browser otvoren", stavi REQUIRE_ACTIVE_BROWSER=true.

## 4) Kreiraj Cloud Scheduler job (svaki minut)

Uzmi URL servisa:

```bash
SERVICE_URL=$(gcloud run services describe telematics-sync --region europe-west1 --format='value(status.url)')
```

Kreiraj scheduler job:

```bash
gcloud scheduler jobs create http telematics-sync-every-minute \
  --location europe-west1 \
  --schedule "* * * * *" \
  --http-method POST \
  --uri "$SERVICE_URL/sync"
```

## 5) Test

Rucno okidanje:

```bash
gcloud scheduler jobs run telematics-sync-every-minute --location europe-west1
```

Cloud Run logovi:

```bash
gcloud run services logs read telematics-sync --region europe-west1 --limit 100
```
