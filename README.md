# ms-files-gce

google cloud storage adapter for ms-files

## Considerations

Useful links:

1. https://cloud.google.com/storage/docs/json_api/v1/how-tos/upload#resumable
2. https://cloud.google.com/storage/docs/access-control

## Workflow

### Uploading

Create resumable upload on a server, pass session id to the client, let the client complete uploading.
Client must notify the server when upload is complete. Once it's done - server checks this information and starts
post-processing

### Downloading

1. Client requests file to download
2. Server check authentication rights
3. On success - creates signed URL and returns 302 redirect + URL
