# ServiceOS Remote Setup

The prepared bootstrap is a complete git repository, but the current GitHub connector available to the Architect can create files/branches/commits/issues/PRs but cannot create a new repository.

## One-time owner action

Create an empty public repository named:

`pectoraux/ServiceOS`

Do not initialize it with a README, license, or `.gitignore` because this bundle already contains the initial commit.

## Push the prepared repository

From the unpacked `ServiceOS` directory:

```bash
git remote add origin https://github.com/pectoraux/ServiceOS.git
git branch -M main
git push -u origin main
```

After that, the GitHub repository becomes the persistent architect record and subsequent implementation can use the governed branch/PR workflow in `docs/WORKFLOW.md`.

## Import alternative

`ServiceOS-bootstrap.bundle` is a Git bundle containing the bootstrap commit and can be cloned with:

```bash
git clone ServiceOS-bootstrap.bundle ServiceOS
```

Then add the GitHub remote and push `main`.
