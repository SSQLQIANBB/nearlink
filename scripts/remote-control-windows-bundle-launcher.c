/* Fixed embedded CPython entry. No interpreter CLI, venv redirector or test flags. */
#define PY_SSIZE_T_CLEAN
#include <Python.h>
#include <windows.h>
#include <stdio.h>
#include <wchar.h>

#define PATH_CAPACITY 32768

static void checked(PyStatus status) {
    if (PyStatus_Exception(status)) {
        fputs("candidate engine initialization failed\n", stderr);
        exit(2);
    }
}

static void path_join(wchar_t *path, const wchar_t *root, const wchar_t *suffix) {
    if (_snwprintf_s(path, PATH_CAPACITY, _TRUNCATE, L"%ls\\%ls", root, suffix) < 0)
        exit(2);
}

static void search_path(PyConfig *config, const wchar_t *root, const wchar_t *suffix) {
    wchar_t path[PATH_CAPACITY];
    path_join(path, root, suffix);
    checked(PyWideStringList_Append(&config->module_search_paths, path));
}

int wmain(int argc, wchar_t **argv) {
    (void)argv;
    if (argc != 1) { fputs("engine arguments forbidden\n", stderr); return 2; }
    wchar_t executable[PATH_CAPACITY], root[PATH_CAPACITY], path[PATH_CAPACITY];
    DWORD length = GetModuleFileNameW(NULL, executable, PATH_CAPACITY);
    if (!length || length >= PATH_CAPACITY) return 2;
    if (wcscpy_s(root, PATH_CAPACITY, executable)) return 2;
    wchar_t *last = wcsrchr(root, L'\\');
    if (!last || (wcscmp(last + 1, L"remote-control-engine.exe") &&
                  wcscmp(last + 1, L"remote-control-screen-source.exe"))) return 2;
    *last = L'\0';
    last = wcsrchr(root, L'\\');
    if (!last || wcscmp(last + 1, L"bin")) return 2;
    *last = L'\0';

    /* python313.dll is delay-loaded: configure search before the first Python call. */
    if (!SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_SYSTEM32 | LOAD_LIBRARY_SEARCH_USER_DIRS)) return 2;
    path_join(path, root, L"runtime");
    if (!AddDllDirectory(path)) return 2;
    path_join(path, root, L"runtime\\DLLs");
    if (!AddDllDirectory(path)) return 2;
    path_join(path, root, L"runtime\\python313.dll");
    if (!LoadLibraryExW(path, NULL, LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32)) return 2;

    PyPreConfig pre;
    PyPreConfig_InitIsolatedConfig(&pre);
    pre.utf8_mode = 1;
    checked(Py_PreInitialize(&pre));
    PyConfig config;
    PyConfig_InitIsolatedConfig(&config);
    config.use_environment = 0;
    config.user_site_directory = 0;
    config.site_import = 0;
    config.write_bytecode = 0;
    config.parse_argv = 0;
    config.module_search_paths_set = 1;
    checked(PyConfig_SetString(&config, &config.executable, executable));
    checked(PyConfig_SetString(&config, &config.program_name, executable));
    wchar_t *arguments[] = {executable};
    checked(PyConfig_SetArgv(&config, 1, arguments));
    path_join(path, root, L"runtime");
    checked(PyConfig_SetString(&config, &config.home, path));
    search_path(&config, root, L"runtime\\Lib");
    search_path(&config, root, L"runtime\\DLLs");
    search_path(&config, root, L"app");
    path_join(path, root, L"app\\entry.py");
    checked(PyConfig_SetString(&config, &config.run_filename, path));
    checked(Py_InitializeFromConfig(&config));
    PyConfig_Clear(&config);
    return Py_RunMain();
}
