export default function NoAccess() {
  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="card max-w-md p-6">
        <h1 className="text-xl font-semibold">This account cannot use the admin app</h1>
        <p className="mt-2 text-muted">
          This account has no role in a company on Drivo yet. If you plan routes or manage the fleet, ask your Owner or Admin to give you the Dispatcher or Admin role.
        </p>
        <form action="/auth/sign-out" method="post" className="mt-4">
          <button className="btn-secondary" type="submit">Sign out</button>
        </form>
      </div>
    </main>
  );
}
