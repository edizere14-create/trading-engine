import py_compile
files = [
    'state_manager.py',
    'api_server.py',
    'pnl_logger.py',
    'shadow_resolver.py',
    'intent_executor.py',
    'trade_executor.py',
    'tests/test_distributed_upgrade.py',
]
for f in files:
    py_compile.compile(f, doraise=True)
    print(f'{f} OK')
print('ALL_COMPILE_OK')
