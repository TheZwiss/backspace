cmake_minimum_required(VERSION 3.20)
project(backspace_process_audio LANGUAGES CXX)
add_executable(backspace-process-audio main.cpp)
target_compile_features(backspace-process-audio PRIVATE cxx_std_17)
target_compile_definitions(backspace-process-audio PRIVATE UNICODE _UNICODE WIN32_LEAN_AND_MEAN)
target_link_libraries(backspace-process-audio PRIVATE ole32 mmdevapi dwmapi)
if(MSVC)
  set_property(TARGET backspace-process-audio PROPERTY MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
endif()
if(MINGW)
  # The helper enters through wmain() for its UTF-16 command line. MinGW's CRT
  # looks for WinMain unless -municode selects the wide entry point.
  # Statically link the runtime: the helper is shipped as one file next to the
  # app, and a machine without MinGW's DLLs must still run it.
  target_link_options(backspace-process-audio PRIVATE -municode -static -static-libgcc -static-libstdc++)
endif()
