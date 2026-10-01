CMAKE_MINIMUM_REQUIRED(VERSION 3.24)
PROJECT(fetchdemo VERSION 0.3.0 LANGUAGES CXX)

include(FetchContent)
include(ExternalProject)

FIND_PACKAGE(ZLIB REQUIRED)
find_package(fmt 10 CONFIG)
find_library(FOO_LIB NAMES foo HINTS /opt/foo/lib PATH_SUFFIXES lib64)

set(GTEST_TAG v1.14.0)
FetchContent_Declare(
  googletest
  GIT_REPOSITORY https://github.com/google/googletest.git
  GIT_TAG        ${GTEST_TAG}
)
FetchContent_Declare(json
  URL https://github.com/nlohmann/json/archive/refs/tags/v3.11.3.tar.gz
  URL_HASH SHA256=0d8ef5af7f9794e3263480193c491549b2ba6cc74bb018906202ada498a79406
)
FetchContent_MakeAvailable(googletest json)

ExternalProject_Add(libfoo
  URL https://downloads.example.org/libfoo-2.1.tar.gz?token=SECRET
  URL_HASH SHA512=ABCDEF0123
  CONFIGURE_COMMAND ""
)

CPMAddPackage("gh:fmtlib/fmt#10.2.1")
