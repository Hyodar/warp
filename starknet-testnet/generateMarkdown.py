import json
import os
import sys
import threading

from pathlib import Path
from starkware.starknet.business_logic.execution.objects import (
    CallInfo,
    TransactionExecutionInfo,
)

WARP_ROOT = Path(__file__).parents[1]
TMP = WARP_ROOT / "benchmark" / "json"
FILE_NAME = "data"
JSON_PATH = os.path.abspath(TMP / (FILE_NAME + ".json"))

contract_name_map = {}

json_lock = threading.Lock()

def steps_in_function_deploy(contract_name: str, result: TransactionExecutionInfo):
    with json_lock:
        if os.path.exists(JSON_PATH):
            with open(JSON_PATH, "r") as json_file:
                benchmark_data = json.load(json_file)
        else:
            benchmark_data = {}

        benchmark_data.setdefault(contract_name, {})[
            "steps"
        ] = result.call_info.execution_resources.n_steps

        with open(JSON_PATH, "w") as json_file:
            json.dump(benchmark_data, json_file, indent=3)

def steps_in_function_invoke(function_name: str, result: CallInfo):
    with json_lock:
        if os.path.exists(JSON_PATH):
            with open(JSON_PATH, "r") as json_file:
                benchmark_data = json.load(json_file)
        else:
            benchmark_data = {}

        contract_name = contract_name_map.get(result.contract_address, "UNKNOWN")
        benchmark_data.setdefault(contract_name, {}).setdefault("function_steps", {})[
            function_name
        ] = result.execution_resources.n_steps

        with open(JSON_PATH, "w") as json_file:
            json.dump(benchmark_data, json_file, indent=3)

def builtin_instance_count(contract_name: str, result: TransactionExecutionInfo):
    with json_lock:
        if os.path.exists(JSON_PATH):
            with open(JSON_PATH, "r") as json_file:
                benchmark_data = json.load(json_file)
        else:
            benchmark_data = {}

        benchmark_data.setdefault(contract_name, {})[
            "builtin_instances"
        ] = result.call_info.execution_resources.builtin_instance_counter

        with open(JSON_PATH, "w") as json_file:
            json.dump(benchmark_data, json_file, indent=3)

def json_size_count(file_path: str):
    with json_lock:
        if os.path.exists(JSON_PATH):
            with open(JSON_PATH, "r") as json_file:
                benchmark_data = json.load(json_file)
        else:
            benchmark_data = {}

        benchmark_data.setdefault(file_path, {})[
            "json_size"
        ] = f"{os.path.getsize(file_path)/1024} KB"

        with open(JSON_PATH, "w") as json_file:
            json.dump(benchmark_data, json_file, indent=3)


def create_markdown():
    with open(JSON_PATH, "r") as json_file:
        benchmark_data = json.load(json_file)

    os.makedirs("benchmark/stats", exist_ok=True)

    with open(
        os.path.join(WARP_ROOT, f"benchmark/stats/{FILE_NAME}.md"), "w"
    ) as md_file:
        md_file.write("# Warp-ts status\n\n")
        md_file.write(f"commit: {FILE_NAME}\n\n")

    for contract, data in benchmark_data.items():
        with open(
            os.path.join(WARP_ROOT, f"benchmark/stats/{FILE_NAME}.md"), "a"
        ) as md_file:
            md_file.write(f"## {os.path.basename(contract)}:\n\n")
            md_file.write("| Metric | Value |\n")
            md_file.write("| ----------- | ----------- |\n")

            for metric, value in sorted(data.items()):
                if metric in ["builtin_instances", "function_steps"]:
                    continue
                md_file.write(f"| {metric} | {value} |\n")
            md_file.write(f"\n")

        if "builtin_instances" in data:
            with open(
                os.path.join(WARP_ROOT, f"benchmark/stats/{FILE_NAME}.md"), "a"
            ) as md_file:
                md_file.write("| Builtin | Instances |\n")
                md_file.write("| ----------- | ----------- |\n")

                for builtin, count in sorted(data["builtin_instances"].items()):
                    md_file.write(f"| {builtin} | {count} |\n")

                md_file.write(f"\n")

        if "function_steps" in data:
            with open(
                os.path.join(WARP_ROOT, f"benchmark/stats/{FILE_NAME}.md"), "a"
            ) as md_file:
                md_file.write("| Function | Steps |\n")
                md_file.write("| ----------- | ----------- |\n")

                for function, steps in sorted(data["function_steps"].items()):
                    md_file.write(f"| {function} | {steps} |\n")

                md_file.write(f"\n")


if __name__ == "__main__":
    if len(sys.argv) >= 2 and sys.argv[1] != None:
        FILE_NAME = sys.argv[1]
        print(sys.argv[1])
    print(FILE_NAME)
    create_markdown()
