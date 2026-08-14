cmake_minimum_required(VERSION 3.20)
project(DownanyProcessHost LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_executable(DownanyProcessHost main.cpp)

if (WIN32)
  target_compile_definitions(DownanyProcessHost PRIVATE UNICODE _UNICODE WIN32_LEAN_AND_MEAN NOMINMAX)
  target_link_libraries(DownanyProcessHost PRIVATE advapi32)
  set_target_properties(DownanyProcessHost PROPERTIES WIN32_EXECUTABLE FALSE)
elseif (APPLE)
  target_compile_options(DownanyProcessHost PRIVATE -Wall -Wextra -Wpedantic)
else()
  message(FATAL_ERROR "DownanyProcessHost only supports Windows and macOS")
endif()

install(TARGETS DownanyProcessHost RUNTIME DESTINATION . BUNDLE DESTINATION .)
