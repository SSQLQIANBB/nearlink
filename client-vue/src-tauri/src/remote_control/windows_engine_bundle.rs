//! Hold read-only, non-delete-sharing handles for the whole running bundle.
use super::*;
use std::{ffi::c_void, os::windows::{fs::{MetadataExt, OpenOptionsExt}, io::AsRawHandle}};

#[repr(C)]
struct FileInfo {
    attributes: u32,
    times: [[u32; 2]; 3],
    volume: u32,
    size_high: u32,
    size_low: u32,
    links: u32,
    index_high: u32,
    index_low: u32,
}
#[link(name = "kernel32")]
extern "system" {
    fn GetFinalPathNameByHandleW(handle: *mut c_void, path: *mut u16, length: u32, flags: u32) -> u32;
    fn GetFileInformationByHandle(handle: *mut c_void, info: *mut FileInfo) -> i32;
}
fn path_of(file: &File) -> Result<PathBuf> {
    let mut buffer = vec![0u16; 32768];
    let size = unsafe { GetFinalPathNameByHandleW(file.as_raw_handle(), buffer.as_mut_ptr(), buffer.len() as u32, 0) };
    if size == 0 || size as usize >= buffer.len() { return Err(fail("resource path unavailable")); }
    Ok(PathBuf::from(String::from_utf16(&buffer[..size as usize]).map_err(|_| fail("invalid resource path"))?))
}
fn open(path: &Path, directory: bool) -> Result<File> {
    let file = std::fs::OpenOptions::new().read(true).share_mode(1)
        .custom_flags(0x02000000 | 0x00200000) // BACKUP_SEMANTICS | OPEN_REPARSE_POINT
        .open(path).map_err(|_| fail("resource missing, writable or inaccessible"))?;
    let metadata = file.metadata().map_err(|_| fail("resource unavailable"))?;
    if metadata.file_attributes() & 0x400 != 0 || metadata.is_dir() != directory ||
        (!directory && !metadata.is_file()) { return Err(fail("resource type or reparse point rejected")); }
    let mut info: FileInfo = unsafe { std::mem::zeroed() };
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 ||
        (!directory && info.links != 1) { return Err(fail("resource identity or hard link rejected")); }
    Ok(file)
}
pub fn read_manifest(root: &Path) -> Result<Vec<u8>> {
    let directory = open(root, true)?;
    let mut file = open(&path_of(&directory)?.join(MANIFEST_FILE), false)?;
    read_bounded(&mut file, MAX_MANIFEST_BYTES)
}
pub fn verify(root: &Path, expected: &[u8], target: &str) -> Result<VerifiedTree> {
    let manifest = parse(expected, target)?;
    if target != "x86_64-pc-windows-msvc" { return Err(fail("unsupported Windows architecture")); }
    let directory = open(root, true)?;
    let canonical = path_of(&directory)?;
    let mut locks = vec![directory];
    let mut manifest_file = open(&canonical.join(MANIFEST_FILE), false)?;
    if read_bounded(&mut manifest_file, MAX_MANIFEST_BYTES)? != expected {
        return Err(fail("manifest differs from compiled trust anchor"));
    }
    locks.push(manifest_file);
    let files: BTreeMap<_, _> = manifest.files.iter().map(|file| (file.path.as_str(), file)).collect();
    let mut folded = BTreeSet::new();
    let mut directories = BTreeSet::new();
    for file in &manifest.files {
        if !folded.insert(file.path.to_lowercase()) || file.path.split('/').any(|part|
            part.ends_with([' ', '.']) || part.contains(['<', '>', '"', '|', '?', '*'])) {
            return Err(fail("ambiguous Windows resource path"));
        }
        let mut parent = Path::new(&file.path).parent();
        while let Some(path) = parent {
            if !path.as_os_str().is_empty() { directories.insert(path.to_string_lossy().replace('\\', "/")); }
            parent = path.parent();
        }
    }
    fn walk(root: &Path, prefix: &str, files: &BTreeMap<&str, &BundleFile>, directories: &BTreeSet<String>,
            seen: &mut BTreeSet<String>, locks: &mut Vec<File>, depth: usize) -> Result<()> {
        if depth > 32 { return Err(fail("resource nesting too deep")); }
        for entry in std::fs::read_dir(root).map_err(|_| fail("directory unreadable"))? {
            let entry = entry.map_err(|_| fail("directory enumeration failed"))?;
            let name = entry.file_name().into_string().map_err(|_| fail("invalid resource name"))?;
            if !relative_path(&name) || name.contains('/') { return Err(fail("invalid resource name")); }
            let relative = if prefix.is_empty() { name } else { format!("{prefix}/{name}") };
            if relative == MANIFEST_FILE { continue; }
            if directories.contains(&relative) {
                let directory = open(&entry.path(), true)?;
                let path = path_of(&directory)?;
                locks.push(directory);
                walk(&path, &relative, files, directories, seen, locks, depth + 1)?;
            } else {
                let spec = files.get(relative.as_str()).ok_or_else(|| fail("unlisted resource"))?;
                let mut file = open(&entry.path(), false)?;
                if file.metadata().map_err(|_| fail("resource unavailable"))?.len() != spec.size {
                    return Err(fail("resource size mismatch"));
                }
                let mut hash = Sha256::new();
                let mut bytes = [0u8; 65536];
                loop {
                    let size = file.read(&mut bytes).map_err(|_| fail("resource unreadable"))?;
                    if size == 0 { break; }
                    hash.update(&bytes[..size]);
                }
                if format!("{:x}", hash.finalize()) != spec.sha256 { return Err(fail("resource hash mismatch")); }
                locks.push(file);
                seen.insert(relative);
            }
        }
        Ok(())
    }
    let mut seen = BTreeSet::new();
    walk(&canonical, "", &files, &directories, &mut seen, &mut locks, 0)?;
    if seen.len() != files.len() { return Err(fail("resource missing")); }
    Ok(VerifiedTree { entrypoint: canonical.join(&manifest.entrypoint), root: canonical,
        manifest, digest: sha256(expected), locks })
}
