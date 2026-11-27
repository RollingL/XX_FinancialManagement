// Windows 10 x64 portable entry point. Build with /MT and /SUBSYSTEM:WINDOWS.
// No shell, process-name termination, data cleanup, or target-machine runtime install.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#define _WIN32_WINNT 0x0A00
#include <windows.h>
#include <shellapi.h>
#include <string>
#include <vector>
#include <stdexcept>

namespace {
class Handle {
public:
    HANDLE value = nullptr;
    explicit Handle(HANDLE h = nullptr) : value(h) {}
    ~Handle() { close(); }
    Handle(const Handle&) = delete;
    Handle& operator=(const Handle&) = delete;
    void close() { if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value); value = nullptr; }
};
struct Failure { std::wstring operation; DWORD code; };
[[noreturn]] void fail(const wchar_t* operation) { throw Failure{operation, GetLastError()}; }

std::wstring executablePath() {
    std::vector<wchar_t> buffer(32768);
    DWORD size = GetModuleFileNameW(nullptr, buffer.data(), static_cast<DWORD>(buffer.size()));
    if (!size || size >= buffer.size()) fail(L"读取启动器路径");
    return std::wstring(buffer.data(), size);
}
HANDLE duplicateStandard(DWORD id, bool input) {
    HANDLE source = GetStdHandle(id), result = nullptr;
    if (source && source != INVALID_HANDLE_VALUE && DuplicateHandle(GetCurrentProcess(), source,
        GetCurrentProcess(), &result, 0, TRUE, DUPLICATE_SAME_ACCESS)) return result;
    SECURITY_ATTRIBUTES security{sizeof(security), nullptr, TRUE};
    result = CreateFileW(L"NUL", input ? GENERIC_READ : GENERIC_WRITE,
        FILE_SHARE_READ | FILE_SHARE_WRITE, &security, OPEN_EXISTING, 0, nullptr);
    if (result == INVALID_HANDLE_VALUE) fail(L"准备诊断输出");
    return result;
}
class Attributes {
    std::vector<unsigned char> storage;
public:
    LPPROC_THREAD_ATTRIBUTE_LIST value = nullptr;
    explicit Attributes(DWORD count) {
        SIZE_T size = 0;
        InitializeProcThreadAttributeList(nullptr, count, 0, &size);
        if (!size) fail(L"准备进程监管");
        storage.resize(size);
        value = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(storage.data());
        if (!InitializeProcThreadAttributeList(value, count, 0, &size)) { value = nullptr; fail(L"初始化进程监管"); }
    }
    ~Attributes() { if (value) DeleteProcThreadAttributeList(value); }
    void set(DWORD_PTR key, void* data, SIZE_T size) {
        if (!UpdateProcThreadAttribute(value, 0, key, data, size, nullptr, nullptr)) fail(L"配置进程监管");
    }
};

DWORD supervise(bool probe, bool diagnostics) {
    const std::wstring launcher = executablePath();
    const auto separator = launcher.find_last_of(L"\\/");
    if (separator == std::wstring::npos) { SetLastError(ERROR_BAD_PATHNAME); fail(L"读取程序目录"); }
    const std::wstring root = launcher.substr(0, separator);
    const std::wstring executable = root + L"\\app\\qianlai-app.exe";
    std::wstring command = L"\"" + executable + L"\" --qianlai-supervised";
    if (probe) command += L" --probe";
    if (diagnostics) command += L" --qianlai-diagnostics";

    // These variables must never turn the packaged GUI into a Node shell.
    for (const auto name : {L"ELECTRON_RUN_AS_NODE", L"ELECTRON_NO_ASAR", L"NODE_OPTIONS", L"NODE_PATH"}) {
        if (!SetEnvironmentVariableW(name, nullptr) && GetLastError() != ERROR_ENVVAR_NOT_FOUND) fail(L"清理启动环境");
    }
    Handle job(CreateJobObjectW(nullptr, nullptr)); // Unnamed and not inheritable.
    if (!job.value) fail(L"创建本应用进程监管");
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (!SetInformationJobObject(job.value, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) fail(L"设置退出清理");

    const bool redirect = probe || diagnostics;
    Handle input(redirect ? duplicateStandard(STD_INPUT_HANDLE, true) : nullptr);
    Handle output(redirect ? duplicateStandard(STD_OUTPUT_HANDLE, false) : nullptr);
    Handle error(redirect ? duplicateStandard(STD_ERROR_HANDLE, false) : nullptr);
    HANDLE standardHandles[]{input.value, output.value, error.value};
    Attributes attributes(redirect ? 2 : 1);
    // Windows 10 assigns the job atomically inside CreateProcess. There is no
    // creation/AssignProcessToJobObject gap if the launcher is forcibly ended.
    attributes.set(PROC_THREAD_ATTRIBUTE_JOB_LIST, &job.value, sizeof(job.value));
    if (redirect) attributes.set(PROC_THREAD_ATTRIBUTE_HANDLE_LIST, standardHandles, sizeof(standardHandles));
    STARTUPINFOEXW startup{};
    startup.StartupInfo.cb = sizeof(startup);
    startup.lpAttributeList = attributes.value;
    if (redirect) {
        startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        startup.StartupInfo.hStdInput = input.value;
        startup.StartupInfo.hStdOutput = output.value;
        startup.StartupInfo.hStdError = error.value;
    }
    PROCESS_INFORMATION process{};
    if (!CreateProcessW(executable.c_str(), command.data(), nullptr, nullptr, redirect,
        EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED | CREATE_NO_WINDOW,
        nullptr, root.c_str(), &startup.StartupInfo, &process)) fail(L"启动钱来（请确认完整解压、Windows 10 x64 和文件权限）");
    Handle child(process.hProcess), thread(process.hThread);
    BOOL assigned = FALSE;
    if (!IsProcessInJob(child.value, job.value, &assigned) || !assigned) {
        const DWORD code = GetLastError();
        // Only the suspended process just created by this invocation is touched.
        TerminateProcess(child.value, ERROR_PROCESS_ABORTED);
        WaitForSingleObject(child.value, INFINITE);
        throw Failure{L"确认进程监管；应用未运行", code ? code : ERROR_ACCESS_DENIED};
    }
    if (ResumeThread(thread.value) == static_cast<DWORD>(-1)) fail(L"启动受监管进程");
    thread.close();
    input.close(); output.close(); error.close();
    if (WaitForSingleObject(child.value, INFINITE) != WAIT_OBJECT_0) fail(L"等待应用退出");
    DWORD code = 0;
    if (!GetExitCodeProcess(child.value, &code)) fail(L"读取应用退出状态");
    job.close(); // Kills any remaining descendants, including OCR workers.
    return code;
}
void report(const std::wstring& message, bool quiet) {
    if (!quiet) { MessageBoxW(nullptr, message.c_str(), L"钱来", MB_OK | MB_ICONERROR); return; }
    const int size = WideCharToMultiByte(CP_UTF8, 0, message.c_str(), -1, nullptr, 0, nullptr, nullptr);
    if (size <= 0) return;
    std::vector<char> utf8(size);
    WideCharToMultiByte(CP_UTF8, 0, message.c_str(), -1, utf8.data(), size, nullptr, nullptr);
    DWORD written = 0;
    WriteFile(GetStdHandle(STD_ERROR_HANDLE), utf8.data(), static_cast<DWORD>(size - 1), &written, nullptr);
}
}
int WINAPI wWinMain(HINSTANCE, HINSTANCE, PWSTR, int) {
    bool probe = false, diagnostics = false;
    try {
        int count = 0;
        wchar_t** arguments = CommandLineToArgvW(GetCommandLineW(), &count);
        if (!arguments) fail(L"读取启动参数");
        bool valid = true;
        for (int index = 1; index < count; ++index) {
            const std::wstring argument(arguments[index]);
            if (argument == L"--probe" && !probe) probe = true;
            else if (argument == L"--diagnostics" && !diagnostics) diagnostics = true;
            else valid = false;
        }
        LocalFree(arguments);
        if (!valid) throw Failure{L"不支持的启动参数；请直接双击 Qianlai.exe", ERROR_INVALID_PARAMETER};
        const DWORD code = supervise(probe, diagnostics);
        if (code != 0) report(L"钱来已退出，错误代码：" + std::to_wstring(code) +
            L"。\n请保留“数据”“备份”和“运行记录”文件夹，使用 START-TEST.cmd 保存诊断日志。", probe || diagnostics);
        return static_cast<int>(code);
    } catch (const Failure& failure) {
        report(failure.operation + L"失败，Windows 错误代码：" + std::to_wstring(failure.code) +
            L"。\n未删除账本、附件或锁文件。请保留完整目录并记录此信息。", probe || diagnostics);
        return static_cast<int>(failure.code ? failure.code : ERROR_PROCESS_ABORTED);
    } catch (...) {
        report(L"启动器出现错误。请保留完整目录并记录此信息。", probe || diagnostics);
        return ERROR_PROCESS_ABORTED;
    }
}
