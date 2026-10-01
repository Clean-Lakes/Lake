export namespace main {

	export class ImageAttachment {
	    name?: string;
	    mime_type: string;
	    data: string;

	    static createFrom(source: any = {}) {
	        return new ImageAttachment(source);
	    }

	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.mime_type = source["mime_type"];
	        this.data = source["data"];
	    }
	}
	export class UIUserAction {
	    surfaceId: string;
	    sourceComponentId: string;
	    name: string;
	    context: Record<string, any>;
	    revision: number;

	    static createFrom(source: any = {}) {
	        return new UIUserAction(source);
	    }

	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.surfaceId = source["surfaceId"];
	        this.sourceComponentId = source["sourceComponentId"];
	        this.name = source["name"];
	        this.context = source["context"];
	        this.revision = source["revision"];
	    }
	}
	export class WorkflowRunRequest {
	    name: string;
	    resource?: string;
	    bindings?: Record<string, string>;
	    targets?: string[];

	    static createFrom(source: any = {}) {
	        return new WorkflowRunRequest(source);
	    }

	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.resource = source["resource"];
	        this.bindings = source["bindings"];
	        this.targets = source["targets"];
	    }
	}
	export class WorkflowV2Request {
	    definition_id?: string;
	    run_id?: string;
	    project_id?: string;
	    retry_writes: boolean;

	    static createFrom(source: any = {}) {
	        return new WorkflowV2Request(source);
	    }

	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.definition_id = source["definition_id"];
	        this.run_id = source["run_id"];
	        this.project_id = source["project_id"];
	        this.retry_writes = source["retry_writes"];
	    }
	}

}

