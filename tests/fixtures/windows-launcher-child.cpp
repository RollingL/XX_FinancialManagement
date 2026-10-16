// Synthetic process tree only. This executable is never packaged or given ledger data.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <string>
#include <vector>

std::wstring setting(const wchar_t* name) {
    wchar_t buffer[32768]{};
    DWORD size = GetEnvironmentVariableW(name, buffer, 32768);
    return size && size < 32768 ? std::wstring(buffer, size) : L"";
}
void write(const std::wstring& file, const std::string& value) {
    const auto temporary = file + L".writing";
    HANDLE handle = CreateFileW(temporary.c_str(), GENERIC_WRITE, FILE_SHARE_READ, nullptr, CREATE_NEW, 0, nullptr);
    if (handle == INVALID_HANDLE_VALUE) ExitProcess(81);
    DWORD count = 0;
    if (!WriteFile(handle, value.data(), static_cast<DWORD>(value.size()), &count, nullptr)) ExitProcess(82);
    CloseHandle(handle);
    if (!MoveFileExW(temporary.c_str(), file.c_str(), MOVEFILE_WRITE_THROUGH)) ExitProcess(82);
}
int WINAPI wWinMain(HINSTANCE, HINSTANCE, PWSTR, int) {
    const auto directory = setting(L"QIANLAI_FIXTURE_DIRECTORY");
    if (directory.empty()) return 83;
    if (std::wstring(GetCommandLineW()).find(L"--fixture-descendant") != std::wstring::npos) {
        write(directory + L"\\descendant.txt", std::to_string(GetCurrentProcessId()));
        Sleep(INFINITE); return 0;
    }
    BOOL inJob = FALSE;
    if (!IsProcessInJob(GetCurrentProcess(), nullptr, &inJob) || !inJob || GetConsoleWindow()) return 84;
    if (std::wstring(GetCommandLineW()).find(L"--qianlai-supervised") == std::wstring::npos) return 85;
    if (!setting(L"NODE_OPTIONS").empty() || !setting(L"ELECTRON_RUN_AS_NODE").empty()) return 86;
    write(directory + L"\\main.txt", std::to_string(GetCurrentProcessId()));
    DWORD written = 0;
    WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), "synthetic stdout\n", 17, &written, nullptr);
    WriteFile(GetStdHandle(STD_ERROR_HANDLE), "synthetic stderr\n", 17, &written, nullptr);
    const auto mode = setting(L"QIANLAI_FIXTURE_MODE");
    if (mode == L"exit") return static_cast<int>(std::stoull(setting(L"QIANLAI_FIXTURE_EXIT")));
    wchar_t executable[32768]{};
    if (!GetModuleFileNameW(nullptr, executable, 32768)) return 87;
    std::wstring command = L"\"" + std::wstring(executable) + L"\" --fixture-descendant";
    STARTUPINFOW startup{}; startup.cb = sizeof(startup);
    PROCESS_INFORMATION child{};
    // A descendant must not be able to opt out of the launcher's private job.
    if (CreateProcessW(executable, command.data(), nullptr, nullptr, FALSE,
        CREATE_NO_WINDOW | CREATE_BREAKAWAY_FROM_JOB, nullptr, nullptr, &startup, &child)) {
        TerminateProcess(child.hProcess, 88); WaitForSingleObject(child.hProcess, INFINITE);
        CloseHandle(child.hThread); CloseHandle(child.hProcess); return 88;
    }
    if (!CreateProcessW(executable, command.data(), nullptr, nullptr, FALSE,
        CREATE_NO_WINDOW, nullptr, nullptr, &startup, &child)) return 89;
    CloseHandle(child.hThread); CloseHandle(child.hProcess);
    if (mode == L"return-with-descendant") {
        for (int index = 0; index < 100; ++index) {
            if (GetFileAttributesW((directory + L"\\descendant.txt").c_str()) != INVALID_FILE_ATTRIBUTES) return 0;
            Sleep(20);
        }
        return 90;
    }
    Sleep(INFINITE); return 0;
}
