class Error(Exception):
    pass


class OperationalError(Error):
    pass


def connect(*_args, **_kwargs):
    raise OperationalError("psycopg stub: database access not available in simulator tests")

