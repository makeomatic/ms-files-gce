# ms-files-gce

google cloud storage adapter for ms-files

## Considerations

Useful links:

1. https://cloud.google.com/storage/docs/json_api/v1/how-tos/upload#resumable
2. https://cloud.google.com/storage/docs/access-control
3. 3. https://cloud.google.com/storage/docs/json_api/v1/#Objects

## Workflow

### Uploading

Create resumable upload on a server, pass session id to the client, let the client complete uploading.
Client must notify the server when upload is complete. Once it's done - server checks this information and starts
post-processing

### Downloading

1. Client requests file to download
2. Server check authentication rights
3. On success - creates signed URL and returns 302 redirect + URL

### Post-processing

Once initial file upload is completed - server may post-process the file. Ideally it would create a new file, which would act as a header or footer, save it in the same bucket with similar access rights. After that compose method should be called, which would concatenate files without using extra bandwidth
