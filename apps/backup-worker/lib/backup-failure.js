const codes = new Map([
 ['Archive no longer available','archive_missing'],
 ['Archive download failed','archive_download_failed'],
 ['Archive too large','archive_too_large'],
 ['Archive ownership mismatch','archive_scope_mismatch'],
 ['Archive changed during retention','archive_changed'],
 ['Archive retention upload failed','archive_upload_failed'],
 ['Archive retention persistence mismatch','archive_verify_failed'],
 ['Invalid archive for wallpaper retention','archive_format_invalid'],
 ['Invalid wallpaper retention timestamp','wallpaper_timestamp_invalid'],
 ['Invalid wallpaper archive rows','wallpaper_rows_invalid'],
 ['Backup database operation failed','database_failed'],
 ['Backup worker authentication failed','worker_auth_failed']
]);
export function backupFailureCode(error){
 return codes.get(error?.message)||'backup_operation_failed';
}
